import type { JobsOptions } from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';
import { env } from '../config/env';

/**
 * Queue topology and the shared Redis connection.
 *
 * Names, payload types and default job options live here rather than beside each
 * processor so a producer and its consumer cannot disagree about either — a typo in
 * a queue name enqueues into a queue nobody reads, and nothing errors.
 */

/**
 * One queue per side effect, named after the work rather than the module.
 *
 * Separate queues so retry policy, rate limits and failure isolation are tunable
 * independently: SMS sends need a limiter to protect Twilio, LLM extraction needs low
 * concurrency because it is slow and expensive, and neither should stall the other.
 * A single shared queue makes all three settings global.
 */
export const QUEUE = {
  /** Send the first recovery SMS after a missed call. */
  RECOVERY: 'recovery',
  /** Extract fields from an inbound reply, pick the next question, respond. */
  INBOUND_MESSAGE: 'inbound-message',
  /** Structured lead SMS + magic link to the owner. */
  NOTIFY_OWNER: 'notify-owner',
  /** Delayed nudge, and conversation expiry. */
  FOLLOWUP: 'followup',
  /** Repeatable maintenance: retention sweep, weekly owner close-out. */
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * Injection tokens.
 *
 * Deliberately here rather than in `jobs.module.ts`. This file imports nothing from
 * the feature modules, so a producer can import a token without pulling in the module
 * graph. Defining them beside the module created a genuine circular import —
 * `jobs.module` → `telephony.module` → `voice.controller` → `jobs.module` — and
 * `queueToken` was `undefined` at decoration time, which surfaces as
 * `TypeError: queueToken is not a function` at boot rather than as a compile error.
 *
 * `@Global()` removes the *Nest DI* import edge; it does nothing about the
 * *JavaScript module* edge.
 */
export const queueToken = (name: QueueName): string => `BULLMQ_QUEUE_${name}`;

/** The Redis connection shared by all producer queues. */
export const REDIS_CONNECTION = 'BULLMQ_REDIS_CONNECTION';

/**
 * Job payloads carry IDs, never entities.
 *
 * A serialised `Call` in Redis is a copy that goes stale the moment anything updates
 * the row — and a job may sit in a delayed set for hours. The processor re-reads,
 * which also means it sees any state change made since the job was enqueued.
 */
export interface RecoveryJobData {
  callId: string;
  businessId: string;
}

export interface InboundMessageJobData {
  messageId: string;
  businessId: string;
}

export interface NotifyOwnerJobData {
  leadId: string;
  businessId: string;
}

export interface FollowupJobData {
  conversationId: string;
  businessId: string;
  kind: 'nudge' | 'expire';
}

export interface JobDataByQueue {
  [QUEUE.RECOVERY]: RecoveryJobData;
  [QUEUE.INBOUND_MESSAGE]: InboundMessageJobData;
  [QUEUE.NOTIFY_OWNER]: NotifyOwnerJobData;
  [QUEUE.FOLLOWUP]: FollowupJobData;
  [QUEUE.MAINTENANCE]: Record<string, never>;
}

/**
 * Default job options.
 *
 * `removeOnComplete` is not optional: without it Redis grows without bound until it
 * hits maxmemory, at which point `noeviction` (docker-compose.yml) turns a slow leak
 * into a hard stop. Keeping a bounded window of completed jobs is what makes that
 * impossible rather than merely unlikely.
 *
 * Failures are kept a week because they are the dead-letter queue — there is no
 * separate one, and a failed recovery SMS is worth inspecting by hand.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 }, // 2s, 4s, 8s, 16s, 32s
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: { age: 604_800 },
};

/**
 * Connection options BullMQ requires.
 *
 * `maxRetriesPerRequest: null` is mandatory — BullMQ manages its own retries and
 * throws on startup if ioredis is configured to give up on a command. `enableReadyCheck:
 * false` avoids a spurious failure against providers that do not implement INFO fully.
 */
export const REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/**
 * Create a Redis connection.
 *
 * Workers need their own: a blocking worker connection cannot also serve queue
 * commands, so sharing one between a Worker and a Queue deadlocks under load. The
 * module decides who shares what; this only builds them.
 */
export function createRedisConnection(): IORedis {
  return new IORedis(env.REDIS_URL, REDIS_OPTIONS);
}

/**
 * Assert the two Redis settings whose failure is silent.
 *
 * `appendonly` off means every delayed job vanishes on restart — the nudges scheduled
 * for tomorrow simply never fire, with no error anywhere. `maxmemory-policy` set to an
 * eviction mode means Redis discards job data under pressure and BullMQ then reads
 * corrupt state. Managed providers default to both of the wrong values, so this runs
 * at boot rather than trusting the deployment.
 *
 * Warns rather than throws: a misconfigured Redis is a serious problem, but refusing
 * to start would take down a system that is otherwise working.
 */
export async function assertRedisDurability(
  connection: IORedis,
): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];

  const [appendonly, policy] = await Promise.all([
    connection.config('GET', 'appendonly') as Promise<string[]>,
    connection.config('GET', 'maxmemory-policy') as Promise<string[]>,
  ]);

  if (appendonly[1] !== 'yes') {
    problems.push(
      `appendonly=${appendonly[1] ?? 'unknown'} (expected "yes") — delayed jobs will be lost on restart`,
    );
  }
  if (policy[1] !== 'noeviction') {
    problems.push(
      `maxmemory-policy=${policy[1] ?? 'unknown'} (expected "noeviction") — job data may be evicted under memory pressure`,
    );
  }

  return { ok: problems.length === 0, problems };
}
