import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { AppModule } from './app.module';
import { InboundMessageProcessor } from './jobs/processors/inbound-message.processor';
import { InboundReconcilerProcessor } from './jobs/processors/inbound-reconciler.processor';
import { RecoveryProcessor } from './jobs/processors/recovery.processor';
import { RetentionProcessor } from './jobs/processors/retention.processor';
import {
  QUEUE,
  createWorkerRedisConnection,
  queueToken,
  type InboundMessageJobData,
  type QueueName,
  type RecoveryJobData,
} from './jobs/queues';
import { PrismaService } from './prisma/prisma.service';

/**
 * The worker entrypoint. Same modules and same image as `main.ts`, different start
 * command (docs/decisions.md D7).
 *
 * `createApplicationContext` gives dependency injection without an HTTP listener. A
 * worker that opens a port is a worker a platform will health-check and restart as if
 * it were a web service.
 *
 * Workers are registered *here* and not in `JobsModule`, which provides producers
 * only. Both processes load the same module graph, so a `Worker` registered in a
 * module would mean the API starts consuming its own jobs — sending SMS from inside
 * the web process, which is precisely what the queue exists to prevent.
 */

/**
 * Concurrency per worker.
 *
 * Low on purpose. The recovery worker's bottleneck is Twilio, not us, and every job
 * is a message that costs money — a burst of parallelism buys nothing and makes a
 * runaway loop more expensive per second.
 */
const RECOVERY_CONCURRENCY = 5;

/**
 * Rate limit for outbound sends.
 *
 * Twilio throttles per number; bursting produces queued messages and out-of-order
 * delivery, which reads to a customer as a broken conversation
 * (`.claude/skills/queues-redis/SKILL.md` §6).
 */
const RECOVERY_LIMITER = { max: 10, duration: 1000 };

/**
 * Concurrency for inbound replies.
 *
 * Lower than recovery, and for a different bottleneck. Each job here is a paid model
 * call taking seconds, not a millisecond API POST — so parallelism multiplies spend
 * and token-per-minute pressure rather than throughput
 * (`.claude/skills/queues-redis/SKILL.md`: LLM processors need low concurrency
 * because they are slow and expensive).
 *
 * Two is also enough. A customer waits on their own reply, not on the queue depth;
 * the only thing more concurrency buys is finishing a burst of *different*
 * conversations marginally sooner, at the cost of a much worse runaway.
 *
 * Deliberately no limiter. With seconds-long jobs, concurrency is already the binding
 * constraint — a rate limit would be an inert knob that reads like protection.
 */
const INBOUND_CONCURRENCY = 2;

/**
 * Maintenance runs alone.
 *
 * The reconciler reads a bounded batch and enqueues it; two of them running at once
 * would select overlapping rows. That is safe — deterministic job ids and the
 * processor's own idempotency absorb it — but it is wasted work, and concurrency 1
 * makes the common case exact rather than merely tolerable.
 */
const MAINTENANCE_CONCURRENCY = 1;

/**
 * How often to look for inbound replies that were never queued.
 *
 * A minute is the trade: it bounds how long a customer waits after a Redis blip,
 * while a normal tick costs one indexed query that returns nothing.
 */
const RECONCILE_EVERY_MS = 60_000;

/**
 * How often to enforce the retention policy (`docs/compliance.md` §7).
 *
 * Daily. The cutoff is 90 days, so the exact hour is irrelevant — what matters is
 * that it runs unattended rather than being something somebody remembers to do.
 */
const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule);

  // NOT `app.enableShutdownHooks()`.
  //
  // That call only installs Nest's own SIGTERM/SIGINT listeners; the lifecycle hooks
  // themselves run from `app.close()` either way — which this file already calls. With
  // both installed, two independent paths close the context on one signal, and the
  // second one reaches `JobsModule.onApplicationShutdown` after the producer
  // connection is already gone:
  //
  //     Error: Connection is closed.
  //       at JobsModule.onApplicationShutdown
  //
  // The process then dies with a stack trace instead of exiting 0, so an orchestrator
  // records a crash on every ordinary deploy — and a crash-looping worker is exactly
  // the thing a deploy is supposed to avoid. Signals are handled at the bottom of this
  // function instead, in one place, so the ordering is explicit: workers first, then
  // their connections, then the context.

  // Each worker gets its own connection: a blocking worker connection cannot also
  // serve queue commands, and sharing one deadlocks under load.
  const connections: IORedis[] = [];
  const workers: Worker[] = [];

  /**
   * Create a worker, wire its handlers, and register it for shutdown.
   *
   * Extracted when the second queue arrived. The duplication it replaces was the
   * `failed` and `stalled` handlers — the two things easiest to forget on a new
   * worker, and the two whose absence is silent: jobs would exhaust their attempts
   * and disappear into the failed set with nothing in the log.
   */
  const startWorker = <T>(
    name: QueueName,
    describe: (data: T) => string,
    // The job name is passed through because the maintenance queue carries more than
    // one schedule. Dispatching on it there keeps a single worker and a single
    // connection rather than one of each per periodic task.
    process: (data: T, jobName: string) => Promise<void>,
    options: {
      concurrency: number;
      limiter?: { max: number; duration: number };
      /** Called when a job has exhausted every attempt. */
      onExhausted?: (data: T, error: Error) => Promise<void>;
    },
  ): Worker<T> => {
    // Worker connections keep their offline queue ON and retry forever — the opposite
    // of the API's producer connection, which fails fast because an HTTP request is
    // waiting on it. Using the producer config here would make a worker abandon
    // commands during exactly the blips it exists to ride out.
    const connection = createWorkerRedisConnection();
    connections.push(connection);

    const worker = new Worker<T>(
      name,
      async (job: Job<T>) => {
        // Attempt number, not just the job id: without it a retry is
        // indistinguishable from a duplicate in the logs.
        logger.log(
          `[${name}] job ${job.id} attempt ${job.attemptsMade + 1} ${describe(job.data)}`,
        );
        await process(job.data, job.name);
      },
      { connection, ...options },
    );

    // A job that exhausts its attempts is a message a customer never received. It
    // stays in the failed set for a week (`DEFAULT_JOB_OPTIONS`) so it can be
    // inspected, but it must also be loud at the moment it happens.
    worker.on('failed', (job, error) => {
      logger.error(
        `[${name}] job ${job?.id} FAILED after ${job?.attemptsMade ?? 0} attempts: ${error.message}`,
      );

      // Exhausted, not merely failed. BullMQ emits `failed` on every attempt; only
      // the last one is terminal, and only then should the row stop being retryable.
      const attempts = job?.opts?.attempts ?? 0;
      if (job && attempts > 0 && job.attemptsMade >= attempts && options.onExhausted) {
        void options.onExhausted(job.data, error).catch((cause: unknown) => {
          logger.error(
            `[${name}] could not record terminal failure for job ${job.id}: ` +
              `${cause instanceof Error ? cause.message : String(cause)}`,
          );
        });
      }
    });

    // A stalled job means the processor blocked the event loop or the process died
    // mid-job. BullMQ re-runs it, which is safe only because processors are
    // idempotent — but a rising rate is a real signal.
    worker.on('stalled', (jobId) => {
      logger.warn(`[${name}] job ${jobId} stalled and will be re-run`);
    });

    workers.push(worker as Worker);
    return worker;
  };

  const recoveryProcessor = app.get(RecoveryProcessor);
  const inboundProcessor = app.get(InboundMessageProcessor);
  const reconciler = app.get(InboundReconcilerProcessor);
  const retention = app.get(RetentionProcessor);
  const prisma = app.get(PrismaService);

  startWorker<RecoveryJobData>(
    QUEUE.RECOVERY,
    (data) => `call=${data.callId}`,
    (data) => recoveryProcessor.process(data),
    { concurrency: RECOVERY_CONCURRENCY, limiter: RECOVERY_LIMITER },
  );

  startWorker<InboundMessageJobData>(
    QUEUE.INBOUND_MESSAGE,
    (data) => `message=${data.messageId}`,
    (data) => inboundProcessor.process(data),
    {
      concurrency: INBOUND_CONCURRENCY,
      // Five attempts with backoff have failed. Leaving the row QUEUED would hide it
      // forever; putting it back to PENDING would re-drive a poisoned message every
      // minute and keep paying for model calls. FAILED stops both and stays queryable.
      onExhausted: async (data, error) => {
        await prisma.db.message.update({
          where: { id: data.messageId, businessId: data.businessId },
          data: {
            processingStatus: 'FAILED',
            processedAt: new Date(),
            processingNote: `retries exhausted: ${error.message}`.slice(0, 500),
          },
        });
        logger.error(
          `[${QUEUE.INBOUND_MESSAGE}] message ${data.messageId} marked FAILED — ` +
            'this customer received no reply and needs a human.',
        );
      },
    },
  );

  // One worker, several schedules, dispatched by job name. An unknown name is logged
  // rather than silently ignored: a scheduler whose name drifts from its handler would
  // otherwise look like it is running fine while doing nothing at all.
  const MAINTENANCE_TASKS: Record<string, () => Promise<void>> = {
    'reconcile-inbound': () => reconciler.process(),
    retention: () => retention.process(),
  };

  startWorker<Record<string, never>>(
    QUEUE.MAINTENANCE,
    () => 'scheduled',
    async (_data, jobName) => {
      const task = MAINTENANCE_TASKS[jobName];
      if (!task) {
        logger.error(
          `[${QUEUE.MAINTENANCE}] no handler for scheduled job "${jobName}" — ` +
            `it will never run. Known: ${Object.keys(MAINTENANCE_TASKS).join(', ')}`,
        );
        return;
      }
      await task();
    },
    { concurrency: MAINTENANCE_CONCURRENCY },
  );

  // The repeatable schedule. Registered by the worker rather than the API so the API
  // never needs to write to Redis at boot — it must be able to start without it.
  //
  // `upsertJobScheduler` is idempotent by id, so N worker replicas converge on one
  // schedule instead of N.
  const maintenanceQueue = app.get<Queue>(queueToken(QUEUE.MAINTENANCE));
  try {
    await maintenanceQueue.upsertJobScheduler(
      'reconcile-inbound',
      { every: RECONCILE_EVERY_MS },
      { name: 'reconcile-inbound' },
    );
    await maintenanceQueue.upsertJobScheduler(
      'retention',
      { every: RETENTION_EVERY_MS },
      { name: 'retention' },
    );
  } catch (error) {
    // Non-fatal: the queues still work, only the automatic sweep is missing. Loud,
    // because without it a failed enqueue is once again unrecoverable.
    logger.error(
      `Could not register the reconciliation schedule — stuck inbound replies will NOT ` +
        `be re-driven automatically: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logger.log(
    `Worker started — consuming [${workers.map((w) => w.name).join(', ')}] ` +
      `(recovery ${RECOVERY_CONCURRENCY} @ ${RECOVERY_LIMITER.max}/s, ` +
      `inbound ${INBOUND_CONCURRENCY}, reconcile every ${RECONCILE_EVERY_MS / 1000}s, ` +
      `retention every ${RETENTION_EVERY_MS / 3_600_000}h)`,
  );

  /**
   * Shut down exactly once.
   *
   * The guard is load-bearing, not defensive habit. `enableShutdownHooks()` installs
   * Nest's own signal listeners, and after closing the context Nest **re-raises the
   * signal** so the default handling still applies — which fires this listener a
   * second time. The second pass then calls `app.close()` again, and
   * `JobsModule.onApplicationShutdown` quits a connection that is already closed:
   *
   *     Error: Connection is closed.
   *       at JobsModule.onApplicationShutdown
   *
   * The process dies with a stack trace instead of exiting cleanly, so an orchestrator
   * records a crash on every ordinary deploy. It stayed hidden while there was one
   * worker and one connection to close — the second worker only widened the window.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`${signal} received — finishing in-flight jobs`);
    // close() stops taking new jobs and waits for in-flight ones. Closing workers
    // before the app context means a processor cannot lose its dependencies
    // mid-job.
    await Promise.all(workers.map((w) => w.close()));
    // Each quit is isolated: one connection already closed by BullMQ must not stop
    // the others from closing, and must not turn a clean shutdown into a crash.
    await Promise.all(
      connections.map((c) =>
        c.quit().catch((error: unknown) => {
          logger.debug(
            `Redis connection already closed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
    );
    await app.close();
    logger.log('Worker stopped cleanly');
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
