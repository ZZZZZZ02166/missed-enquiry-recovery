import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { AppModule } from './app.module';
import { RecoveryProcessor } from './jobs/processors/recovery.processor';
import { QUEUE, createRedisConnection, type RecoveryJobData } from './jobs/queues';

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

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(AppModule);

  // Without this, a deploy kills workers mid-job. Those jobs stall and re-run —
  // survivable only because processors are idempotent, but no reason to rely on it.
  app.enableShutdownHooks();

  const recoveryProcessor = app.get(RecoveryProcessor);

  // Each worker gets its own connection: a blocking worker connection cannot also
  // serve queue commands, and sharing one deadlocks under load.
  const connections: IORedis[] = [];
  const workers: Worker[] = [];

  const recoveryConnection = createRedisConnection();
  connections.push(recoveryConnection);

  const recoveryWorker = new Worker<RecoveryJobData>(
    QUEUE.RECOVERY,
    async (job: Job<RecoveryJobData>) => {
      // Attempt number, not just the job id: without it a retry is indistinguishable
      // from a duplicate in the logs.
      logger.log(
        `[${QUEUE.RECOVERY}] job ${job.id} attempt ${job.attemptsMade + 1} call=${job.data.callId}`,
      );
      await recoveryProcessor.process(job.data);
    },
    {
      connection: recoveryConnection,
      concurrency: RECOVERY_CONCURRENCY,
      limiter: RECOVERY_LIMITER,
    },
  );
  workers.push(recoveryWorker);

  // A job that exhausts its attempts is a message a caller never received. It stays
  // in the failed set for a week (`DEFAULT_JOB_OPTIONS`) so it can be inspected, but
  // it must also be loud at the moment it happens.
  recoveryWorker.on('failed', (job, error) => {
    logger.error(
      `[${QUEUE.RECOVERY}] job ${job?.id} FAILED after ${job?.attemptsMade ?? 0} attempts: ${error.message}`,
    );
  });

  // A stalled job means the processor blocked the event loop or the process died
  // mid-job. BullMQ re-runs it, which is safe only because processors are idempotent
  // — but a rising rate is a real signal.
  recoveryWorker.on('stalled', (jobId) => {
    logger.warn(`[${QUEUE.RECOVERY}] job ${jobId} stalled and will be re-run`);
  });

  logger.log(
    `Worker started — consuming [${workers.map((w) => w.name).join(', ')}] ` +
      `(concurrency ${RECOVERY_CONCURRENCY}, ${RECOVERY_LIMITER.max}/s)`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`${signal} received — finishing in-flight jobs`);
    // close() stops taking new jobs and waits for in-flight ones. Closing workers
    // before the app context means a processor cannot lose its dependencies
    // mid-job.
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(connections.map((c) => c.quit()));
    await app.close();
    logger.log('Worker stopped cleanly');
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
