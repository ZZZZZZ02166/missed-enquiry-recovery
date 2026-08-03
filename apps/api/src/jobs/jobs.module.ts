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
import { CallsModule } from '../calls/calls.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { RecoveryProcessor } from './processors/recovery.processor';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE,
  REDIS_CONNECTION,
  assertRedisDurability,
  createRedisConnection,
  queueToken,
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

// `queueToken` and `REDIS_CONNECTION` are defined in `queues.ts`, NOT here.
//
// Defining them beside the module meant every producer had to import this file,
// which imports the feature modules — a circular import
// (jobs.module → telephony.module → voice.controller → jobs.module) that left the
// token `undefined` at decoration time and killed the API at boot with
// `TypeError: queueToken is not a function`. tsc reported no error, because the
// types resolve fine.
//
// Re-exported so existing imports keep working; new code should import from
// `./queues` directly.
export { REDIS_CONNECTION, queueToken } from './queues';

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

/**
 * Processors are *provided* here but no `Worker` is created — `worker.ts` does that.
 * Registering the class makes it injectable in both processes; only the worker
 * actually consumes jobs, which is what keeps the API from sending SMS inside a web
 * request.
 *
 * `CallsModule` and `TelephonyModule` are imported for the processors' dependencies.
 * Nothing imports `JobsModule` back — producers reach the queues through the
 * `@Global()` DI scope. Note that this avoids a *Nest* cycle only; the JavaScript
 * import cycle is avoided separately, by keeping the tokens in `queues.ts`.
 */
@Global()
@Module({
  imports: [CallsModule, TelephonyModule],
  providers: [connectionProvider, ...queueProviders, RecoveryProcessor],
  exports: [
    REDIS_CONNECTION,
    ...queueProviders.map((p) => (p as { provide: string }).provide),
    RecoveryProcessor,
  ],
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
