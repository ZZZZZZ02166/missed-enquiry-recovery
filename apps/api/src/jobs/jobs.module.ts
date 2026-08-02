import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE,
  assertRedisDurability,
  createRedisConnection,
  type QueueName,
} from './queues';

/**
 * Queues as injectable providers.
 *
 * `@Global()` for the same reason as `PrismaModule`: producers live in almost every
 * feature module, and importing `JobsModule` in each one is noise that hides nothing
 * useful. These are the only two global modules in the codebase.
 *
 * This module provides *producers* only. Processors are registered by `worker.ts`,
 * which loads the same module graph without an HTTP listener (D7). That split is why
 * the API never accidentally starts consuming its own jobs.
 */

/** Injection token for a queue. `inject(queueToken(QUEUE.RECOVERY))`. */
export const queueToken = (name: QueueName): string => `BULLMQ_QUEUE_${name}`;

/** The Redis connection shared by all producer queues. */
export const REDIS_CONNECTION = 'BULLMQ_REDIS_CONNECTION';

/**
 * One connection for every producer queue.
 *
 * Producers only issue commands, so sharing is correct and avoids five sockets per
 * process. Workers are the exception — a blocking worker connection cannot also serve
 * commands, so `worker.ts` creates its own per worker.
 */
const connectionProvider: Provider = {
  provide: REDIS_CONNECTION,
  useFactory: (): IORedis => createRedisConnection(),
};

const queueProviders: Provider[] = Object.values(QUEUE).map((name) => ({
  provide: queueToken(name),
  inject: [REDIS_CONNECTION],
  useFactory: (connection: IORedis): Queue =>
    new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
}));

@Global()
@Module({
  providers: [connectionProvider, ...queueProviders],
  exports: [REDIS_CONNECTION, ...queueProviders.map((p) => (p as { provide: string }).provide)],
})
export class JobsModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsModule.name);

  constructor(@Inject(REDIS_CONNECTION) private readonly connection: IORedis) {}

  /**
   * Check the two Redis settings whose failure is silent, at boot.
   *
   * Without `appendonly`, every delayed job is lost on restart — tomorrow's nudges
   * simply never fire, with no error anywhere. With an eviction policy, Redis discards
   * job data under memory pressure and BullMQ reads corrupt state. Managed providers
   * default to both wrong values, so this must not be left to the deployment.
   *
   * Warns rather than throws: a misconfigured queue is serious, but refusing to start
   * would take down an API that is still answering calls correctly. The failure this
   * guards is invisible, so a visible warning at startup is the whole point.
   */
  async onModuleInit(): Promise<void> {
    try {
      const { ok, problems } = await assertRedisDurability(this.connection);
      if (ok) {
        this.logger.log('Redis durability OK (appendonly=yes, maxmemory-policy=noeviction)');
        return;
      }
      for (const problem of problems) {
        this.logger.error(`REDIS MISCONFIGURED: ${problem}`);
      }
    } catch (error) {
      // Managed Redis often forbids CONFIG GET. That is not itself a fault — but it
      // does mean the settings are unverified, and saying so is more useful than
      // silence.
      this.logger.warn(
        `Could not verify Redis durability settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Close the connection on shutdown so a deploy does not leave sockets open.
   *
   * Queues share this connection, so closing it closes them. Workers own theirs and
   * close separately in `worker.ts`.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.connection.quit();
  }
}
