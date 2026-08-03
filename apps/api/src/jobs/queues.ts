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
 * Connection options for **workers**.
 *
 * `maxRetriesPerRequest: null` is mandatory — BullMQ manages its own retries and
 * throws on startup if ioredis is configured to give up on a command. `enableReadyCheck:
 * false` avoids a spurious failure against providers that do not implement INFO fully.
 *
 * The offline queue stays **on** here, deliberately. A worker's whole job is to keep
 * trying: buffering commands across a Redis blip is what lets it resume without a
 * restart, and nothing is waiting on a worker command the way an HTTP request waits on
 * a producer's.
 */
export const WORKER_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/**
 * Connection options for **producers** — the API process.
 *
 * The difference that matters is `enableOfflineQueue: false`. With the default, a
 * command issued while Redis is unreachable is buffered rather than rejected, and the
 * promise never settles: measured at 8s still pending, against 1ms to reject with the
 * offline queue off. Inside a Twilio webhook that is an un-catchable hang on a request
 * with a ~15s budget.
 *
 * **This alone is not sufficient**, which is the part that is easy to get wrong.
 * `Queue.add()` first awaits BullMQ's own `waitUntilReady()`, which resolves on `ready`
 * and rejects on `end` — and a client with a retrying `retryStrategy` against a dead
 * Redis reaches neither, cycling `connecting → error → reconnecting` indefinitely. So
 * the hang simply moves inside BullMQ. `addJobBounded` below is what actually bounds
 * it; these options bound the *command* once past readiness, e.g. a mid-flight
 * disconnect.
 */
export const PRODUCER_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  enableOfflineQueue: false,
  connectTimeout: 3000,
  commandTimeout: 3000,
};

/**
 * How long an enqueue may take before the caller gives up.
 *
 * Sized against Twilio's ~15s webhook budget with room for the database writes that
 * precede it. Exceeding it is not fatal: the message is already durably `PENDING` and
 * the reconciler will re-drive it.
 */
export const ENQUEUE_TIMEOUT_MS = 2000;

/** Producer connection — fail fast, because an HTTP request is waiting on it. */
export function createProducerRedisConnection(): IORedis {
  return new IORedis(env.REDIS_URL, PRODUCER_REDIS_OPTIONS);
}

/**
 * Worker connection — keep trying.
 *
 * Each worker needs its own: a blocking worker connection cannot also serve queue
 * commands, so sharing one between a Worker and a Queue deadlocks under load.
 *
 * Never use this for producers, and never use the producer connection for a Worker:
 * a worker on a fail-fast connection would abandon commands during exactly the blips
 * it is supposed to ride out.
 */
export function createWorkerRedisConnection(): IORedis {
  return new IORedis(env.REDIS_URL, WORKER_REDIS_OPTIONS);
}

/** Raised when an enqueue does not complete inside `ENQUEUE_TIMEOUT_MS`. */
export class EnqueueTimeoutError extends Error {
  constructor(queueName: string, ms: number) {
    super(`Enqueue to "${queueName}" did not complete within ${ms}ms — Redis is unreachable`);
    this.name = 'EnqueueTimeoutError';
  }
}

/**
 * Add a job with a hard upper bound on how long it may take.
 *
 * The single place that converts "Redis is unreachable" from an unbounded hang into a
 * rejection a caller can act on. Used by the webhook path and the reconciler alike, so
 * neither can accidentally reintroduce the hang.
 *
 * The losing `add()` promise is deliberately left to settle on its own rather than
 * cancelled — there is no way to cancel it, and if Redis recovers it may still enqueue
 * the job. That is harmless: the job id is deterministic, so a late arrival collapses
 * onto whatever the reconciler already added.
 */
export async function addJobBounded<T extends object>(
  queue: { name: string; add: (name: string, data: T, opts?: JobsOptions) => Promise<unknown> },
  jobName: string,
  data: T,
  opts?: JobsOptions,
  timeoutMs: number = ENQUEUE_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      queue.add(jobName, data, opts),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new EnqueueTimeoutError(queue.name, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wait for a connection to be usable, bounded.
 *
 * Needed because `enableOfflineQueue: false` rejects commands issued before the socket
 * is ready — including the durability check at boot, which would otherwise report a
 * perfectly healthy Redis as broken on every start.
 */
export async function waitForRedisReady(connection: IORedis, timeoutMs: number): Promise<boolean> {
  if (connection.status === 'ready') return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      connection.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    function onReady(): void {
      clearTimeout(timer);
      resolve(true);
    }
    connection.once('ready', onReady);
  });
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
