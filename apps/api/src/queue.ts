import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { ENGINE_KEYS, type EngineSet } from './engines.js';
import type { SiteFetcher } from './audits/fetch.js';
import { completeAudit, processLead, runSiteAudit, type TaskQueue } from './audits/pipeline.js';
import type { Mailer } from './mailer.js';
import { processCall, type CallJob, type CallQueue } from './tracker/runs.js';

const SITE_QUEUE = 'site-audits';
const LEAD_QUEUE = 'leads';
interface TaskJob {
  id: string;
  agencyId: string;
}

// One queue per engine, so each engine has its own rate limit and a slow or
// failing engine never holds up the others.
const queueName = (engineKey: string) => `calls-${engineKey}`;

export interface QueueOptions {
  prefix?: string;
  /** Delay before the first retry of a failed call; doubles each attempt. */
  backoffMs?: number;
}

export function createQueue(options: QueueOptions = {}): CallQueue & TaskQueue & { close(): Promise<void> } {
  // The API should fail fast when Redis is down, so the run can be refunded.
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 5000 });
  connection.on('error', () => {}); // surfaced through the failing command instead
  const queues = new Map<string, Queue>();
  const queueFor = (engineKey: string): Queue => {
    let queue = queues.get(engineKey);
    if (!queue) {
      queue = new Queue(queueName(engineKey), {
        connection,
        prefix: options.prefix ?? config.queuePrefix,
        defaultJobOptions: {
          attempts: config.engineAttempts,
          backoff: { type: 'exponential', delay: options.backoffMs ?? 5000 },
          removeOnComplete: true,
          removeOnFail: 500,
        },
      });
      queues.set(engineKey, queue);
    }
    return queue;
  };

  const tasks = new Map<string, Queue>();
  const taskQueue = (name: string): Queue => {
    let queue = tasks.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection,
        prefix: options.prefix ?? config.queuePrefix,
        defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: options.backoffMs ?? 10_000 }, removeOnComplete: true, removeOnFail: 500 },
      });
      tasks.set(name, queue);
    }
    return queue;
  };

  return {
    async siteAudit(id, agencyId) {
      await taskQueue(SITE_QUEUE).add('site', { id, agencyId } satisfies TaskJob, { jobId: id });
    },
    async lead(id, agencyId) {
      await taskQueue(LEAD_QUEUE).add('lead', { id, agencyId } satisfies TaskJob, { jobId: id });
    },
    async enqueue(jobs) {
      const byEngine = new Map<string, CallJob[]>();
      for (const job of jobs) byEngine.set(job.engineKey, [...(byEngine.get(job.engineKey) ?? []), job]);
      for (const [engineKey, group] of byEngine) {
        // The result id doubles as the job id, so a call can never be queued twice.
        await queueFor(engineKey).addBulk(group.map((job) => ({ name: 'call', data: job, opts: { jobId: job.resultId } })));
      }
    },
    async close() {
      await Promise.all([...queues.values(), ...tasks.values()].map((q) => q.close()));
      connection.disconnect();
    },
  };
}

export interface AuditWorkerDeps {
  fetcher: SiteFetcher;
  mailer: Mailer;
  queue: CallQueue & TaskQueue;
  siteMode: 'live' | 'mock';
}

export function startWorkers(
  engines: EngineSet,
  options: QueueOptions & { onError?: (err: Error) => void; audit?: AuditWorkerDeps } = {},
): { close(): Promise<void> } {
  const audit = options.audit;
  // A connection handed to BullMQ stays ours to close, so keep hold of each one.
  const connections: Redis[] = [];
  const workers: Worker<any>[] = ENGINE_KEYS.map((engineKey) => {
    const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', (err) => options.onError?.(err));
    connections.push(connection);
    const worker = new Worker<CallJob>(
      queueName(engineKey),
      (job) =>
        processCall(engines, job.data, { number: job.attemptsMade + 1, max: job.opts.attempts ?? 1 }, audit ? (runId) => completeAudit({ runId }, audit.mailer) : undefined),
      {
        connection,
        prefix: options.prefix ?? config.queuePrefix,
        concurrency: config.workerConcurrency,
        limiter: { max: Math.max(1, config.engineCallsPerSecond), duration: 1000 },
      },
    );
    worker.on('error', (err) => options.onError?.(err));
    return worker;
  });

  if (audit) {
    const taskWorker = (name: string, handle: (job: TaskJob) => Promise<void>, concurrency: number) => {
      const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      connection.on('error', (err) => options.onError?.(err));
      connections.push(connection);
      const worker = new Worker<TaskJob>(name, (job) => handle(job.data), { connection, prefix: options.prefix ?? config.queuePrefix, concurrency });
      worker.on('error', (err) => options.onError?.(err));
      workers.push(worker);
    };
    taskWorker(SITE_QUEUE, (job) => runSiteAudit(audit.fetcher, job.id, job.agencyId, audit.mailer), 3);
    taskWorker(LEAD_QUEUE, (job) => processLead({ engines, queue: audit.queue, tasks: audit.queue, siteMode: audit.siteMode, mailer: audit.mailer }, job.id, job.agencyId), 2);
  }
  return {
    /** Waits for calls in progress to finish, then disconnects. */
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      for (const connection of connections) connection.disconnect();
    },
  };
}
