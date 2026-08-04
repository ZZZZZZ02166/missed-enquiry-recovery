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
import { ConversationsModule } from '../conversations/conversations.module';
import { TelephonyModule } from '../telephony/telephony.module';
import { InboundMessageProcessor } from './processors/inbound-message.processor';
import { InboundReconcilerProcessor } from './processors/inbound-reconciler.processor';
import { RecoveryProcessor } from './processors/recovery.processor';
import { RetentionProcessor } from './processors/retention.processor';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE,
  REDIS_CONNECTION,
  assertRedisDurability,
  createProducerRedisConnection,
  queueToken,
  waitForRedisReady,
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
  useFactory: (): IORedis => createProducerRedisConnection(),
};

/**
 * How long to wait for Redis at boot before continuing without it.
 *
 * The API must come up regardless: with Redis down it can still validate signatures,
 * store inbound messages, and honour STOP — all of which are obligations that do not
 * depend on a queue. Blocking startup on Redis converts a degraded service into a
 * total outage, including for the one path that has legal weight.
 */
const REDIS_READY_TIMEOUT_MS = 5000;

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
 * `CallsModule`, `TelephonyModule` and `ConversationsModule` are imported for the
 * processors' dependencies. Nothing imports `JobsModule` back — producers reach the
 * queues through the `@Global()` DI scope. Note that this avoids a *Nest* cycle only;
 * the JavaScript import cycle is avoided separately, by keeping the tokens in
 * `queues.ts`.
 *
 * `ConversationsModule` is the dependency that costs money. Importing it here is what
 * gives `InboundMessageProcessor` the model provider — and because the factory runs at
 * module construction, a worker started with the wrong configuration now fails at boot
 * rather than on the first customer reply.
 */
@Global()
@Module({
  imports: [CallsModule, TelephonyModule, ConversationsModule],
  providers: [
    connectionProvider,
    ...queueProviders,
    RecoveryProcessor,
    InboundMessageProcessor,
    InboundReconcilerProcessor,
    RetentionProcessor,
  ],
  exports: [
    REDIS_CONNECTION,
    ...queueProviders.map((p) => (p as { provide: string }).provide),
    RecoveryProcessor,
    InboundMessageProcessor,
    InboundReconcilerProcessor,
    RetentionProcessor,
  ],
})
export class JobsModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsModule.name);

  private degraded = false;

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
    // Time-boxed, and this is the part that used to take the whole API down. The
    // check issues CONFIG GET; with the producer's offline queue disabled that
    // command is rejected while disconnected, but before this the default buffered
    // it forever and `onModuleInit` never returned — Nest never called listen(), so
    // the process ran with no HTTP server at all. Measured: /health unreachable, last
    // log line PrismaService. Redis being down became a complete outage.
    const ready = await waitForRedisReady(this.connection, REDIS_READY_TIMEOUT_MS);

    if (!ready) {
      this.degraded = true;
      this.logger.error(
        `REDIS UNAVAILABLE after ${REDIS_READY_TIMEOUT_MS}ms — starting in DEGRADED mode. ` +
          'Webhooks will be accepted and stored, STOP will be honoured, but replies ' +
          'cannot be queued and will be left PENDING for the reconciler to re-drive.',
      );
      return;
    }

    try {
      const { ok, problems } = await assertRedisDurability(this.connection);
      if (ok) {
        this.logger.log('Redis durability OK (appendonly=yes, maxmemory-policy=noeviction)');
        return;
      }
      // Reachable but configured unsafely is a different class of problem from
      // unreachable, and it does not heal on its own: every delayed job would be
      // silently lost on the next restart. Refuse to start rather than run a queue
      // that quietly drops work.
      for (const problem of problems) {
        this.logger.error(`REDIS MISCONFIGURED: ${problem}`);
      }
      throw new Error(
        `Refusing to start: Redis is reachable but unsafe for BullMQ — ${problems.join('; ')}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Refusing to start')) throw error;
      // Managed Redis often forbids CONFIG GET. That is not itself a fault — but it
      // does mean the settings are unverified, and saying so is more useful than
      // silence.
      this.logger.warn(
        `Could not verify Redis durability settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** True when Redis was unreachable at boot. Surfaced by /health/ready. */
  get isDegraded(): boolean {
    return this.degraded;
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
