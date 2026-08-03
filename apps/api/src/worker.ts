import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { AppModule } from './app.module';
import { InboundMessageProcessor } from './jobs/processors/inbound-message.processor';
import { RecoveryProcessor } from './jobs/processors/recovery.processor';
import {
  QUEUE,
  createRedisConnection,
  type InboundMessageJobData,
  type QueueName,
  type RecoveryJobData,
} from './jobs/queues';

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
    process: (data: T) => Promise<void>,
    options: { concurrency: number; limiter?: { max: number; duration: number } },
  ): Worker<T> => {
    const connection = createRedisConnection();
    connections.push(connection);

    const worker = new Worker<T>(
      name,
      async (job: Job<T>) => {
        // Attempt number, not just the job id: without it a retry is
        // indistinguishable from a duplicate in the logs.
        logger.log(
          `[${name}] job ${job.id} attempt ${job.attemptsMade + 1} ${describe(job.data)}`,
        );
        await process(job.data);
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
    { concurrency: INBOUND_CONCURRENCY },
  );

  logger.log(
    `Worker started — consuming [${workers.map((w) => w.name).join(', ')}] ` +
      `(recovery ${RECOVERY_CONCURRENCY} @ ${RECOVERY_LIMITER.max}/s, ` +
      `inbound ${INBOUND_CONCURRENCY})`,
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
