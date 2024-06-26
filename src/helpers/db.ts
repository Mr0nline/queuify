/* eslint-disable @typescript-eslint/no-explicit-any */
import Redis from 'ioredis';

import { tDbConnectOptions } from '../types';
import { decompressData, getQueuifyKey } from './utils';
import { JOB_ALREADY_EXISTS } from './messages';
import { DB_FIELDS, QUEUIFY_JOB_FIELDS, QUEUIFY_JOB_STATUS, QUEUIFY_KEY_TYPES } from './constants';

// noinspection Annotator
export const connectToDb = (...args: tDbConnectOptions): Redis => {
  return !args.length
    ? new Redis()
    : args.length === 1
    ? new Redis(args[0] as any)
    : args.length === 2
    ? new Redis(args[0] as any, args[1] as any)
    : new Redis(args[0], args[1], args[2]);
};

export class DBActions {
  public db;

  constructor(db: Redis) {
    this.db = db;
  }

  public async getJobs(queueName: string, from: QUEUIFY_JOB_STATUS, limit = 1) {
    const queuifyListKey = getQueuifyKey(queueName, QUEUIFY_KEY_TYPES.RUNS, from);
    const queuifyRunsKey = getQueuifyKey(queueName, QUEUIFY_KEY_TYPES.RUNS);

    const jobIds = [];
    for (let i = 0; i < limit; i++) {
      const jobId = await this.db.lmove(
        queuifyListKey,
        `${queuifyRunsKey}:${QUEUIFY_JOB_STATUS.RUNNING}`,
        DB_FIELDS.LEFT,
        DB_FIELDS.RIGHT,
      );
      if (!jobId) break;
      jobIds.push(jobId);
    }

    if (!jobIds.length) return [];

    const jobsPipeline = this.db.multi();
    const statusPipeline = this.db.multi();

    for (const jobId of jobIds) {
      jobsPipeline.hmget(`${queuifyRunsKey}:${jobId}`, QUEUIFY_JOB_FIELDS.JOB_ID, QUEUIFY_JOB_FIELDS.DATA);
      statusPipeline.hset(`${queuifyRunsKey}:${jobId}`, QUEUIFY_JOB_FIELDS.STATUS, QUEUIFY_JOB_STATUS.RUNNING);
    }
    const results = await Promise.allSettled([jobsPipeline.exec(), statusPipeline.exec()]);
    const jobsResults = results[0];
    if (jobsResults.status === 'rejected') throw jobsResults.reason;
    const jobs = [];
    for (const result of jobsResults.value || []) {
      const [jobId, data] = result[1] as string[];
      const job = {
        id: jobId,
        data: decompressData(data),
      };
      jobs.push(job);
    }

    return jobs;
  }

  public async completeJob(queueName: string, jobId: string) {
    const queuifyKey = getQueuifyKey(queueName, QUEUIFY_KEY_TYPES.RUNS);
    const jobPipeline = this.db.multi();
    jobPipeline.hset(`${queuifyKey}:${jobId}`, QUEUIFY_JOB_FIELDS.STATUS, QUEUIFY_JOB_STATUS.COMPLETED);
    jobPipeline.lrem(`${queuifyKey}:${QUEUIFY_JOB_STATUS.RUNNING}`, 1, jobId);
    jobPipeline.lpush(`${queuifyKey}:${QUEUIFY_JOB_STATUS.COMPLETED}`, jobId);
    await jobPipeline.exec();
  }

  public async updateJob(queueName: string, jobId: string, newData: string) {
    const queuifyRunsKey = getQueuifyKey(queueName, QUEUIFY_KEY_TYPES.RUNS);
    const queuifyRunsJobKey = `${queuifyRunsKey}:${jobId}`;
    await this.db.hset(queuifyRunsJobKey, QUEUIFY_JOB_FIELDS.DATA, newData);
  }

  public async failJob(queueName: string, jobId: string, failedReason: string) {
    const queuifyKey = getQueuifyKey(queueName, QUEUIFY_KEY_TYPES.RUNS);
    const jobPipeline = this.db.multi();
    jobPipeline.hset(
      `${queuifyKey}:${jobId}`,
      QUEUIFY_JOB_FIELDS.STATUS,
      QUEUIFY_JOB_STATUS.FAILED,
      QUEUIFY_JOB_FIELDS.FAILED_REASON,
      failedReason,
    );
    jobPipeline.lrem(`${queuifyKey}:${QUEUIFY_JOB_STATUS.RUNNING}`, 1, jobId);
    jobPipeline.lpush(`${queuifyKey}:${QUEUIFY_JOB_STATUS.FAILED}`, jobId);
    await jobPipeline.exec();
  }

  public async moveJobsBetweenLists(queueName: string, from: QUEUIFY_JOB_STATUS, to: QUEUIFY_JOB_STATUS) {
    const queuifyKey = getQueuifyKey(queueName, QUEUIFY_KEY_TYPES.RUNS);
    const fromList = `${queuifyKey}:${from}`;
    const toList = `${queuifyKey}:${to}`;
    const jobRuns = await this.db.lrange(fromList, 0, -1);
    if (!jobRuns) return [];
    const jobMovePipeline = this.db.multi();
    for (const jobId of jobRuns) {
      // Move item from fromList's head(LEFT) to toList's tail(RIGHT).
      // L1 = 3,2,1
      // L2 = 6,5,4
      // Moving head to tail makes L2 6,5,4,3,2,1
      // When the Engine will pop from tail, It will process in an order of 3,2,1 which is desired order
      jobMovePipeline.lmove(fromList, toList, DB_FIELDS.LEFT, DB_FIELDS.RIGHT);
      jobMovePipeline.hset(`${queuifyKey}:${jobId}`, QUEUIFY_JOB_FIELDS.STATUS, to);
    }

    await jobMovePipeline.exec();

    return jobRuns;
  }

  public async addJob(queueName: string, jobId: string, data: string) {
    const queuifyKey = getQueuifyKey(queueName);
    const queuifyRunsKey = getQueuifyKey(queueName, QUEUIFY_KEY_TYPES.RUNS);
    const queuifyRunsJobKey = `${queuifyRunsKey}:${jobId}`;
    const queuifyRunsPendingKey = getQueuifyKey(queueName, QUEUIFY_KEY_TYPES.RUNS, QUEUIFY_JOB_STATUS.PENDING);

    const script = `
    local queuifyRunsJobKey = KEYS[1]
    local queuifyKey = KEYS[2]
    local queuifyRunsPendingKey = KEYS[3]
    local data = ARGV[1]
    local jobId = ARGV[2]

    local exists = redis.call('exists', queuifyRunsJobKey)
    if exists == 1 then
      return redis.error_reply('${JOB_ALREADY_EXISTS(jobId, queueName)}')
    end
    
    
    local jobStatusKey = '${QUEUIFY_JOB_FIELDS.STATUS}'
    local jobDataKey = '${QUEUIFY_JOB_FIELDS.DATA}'
    local jobStatusValue = '${QUEUIFY_JOB_STATUS.PENDING}'
    redis.call('hset', queuifyRunsJobKey, '${
      QUEUIFY_JOB_FIELDS.JOB_ID
    }', jobId, jobStatusKey, jobStatusValue, jobDataKey, data)
    
    redis.call('lpush', queuifyRunsPendingKey, jobId)
  `;

    await this.db.eval(script, 3, queuifyRunsJobKey, queuifyKey, queuifyRunsPendingKey, data, jobId);
  }
}
