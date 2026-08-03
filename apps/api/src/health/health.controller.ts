import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS_CONNECTION } from '../jobs/queues';
import { PrismaService } from '../prisma/prisma.service';

/** Bounded so a wedged dependency cannot hang the health check itself. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Backlog age that counts as an incident. Matches the reconciler's own threshold so
 * a log-based alert and a metric-based one fire together rather than disagreeing.
 */
const BACKLOG_ALERT_AFTER_MS = 10 * 60 * 1000;

interface Readiness {
  status: 'ok' | 'degraded';
  database: 'ok' | 'unreachable';
  redis: 'ok' | 'unreachable';
  /**
   * Inbound replies stored but not yet handed to a worker.
   *
   * Exposed here so alerting does not have to scrape logs: a monitor already polls
   * readiness, and `oldestAgeSeconds` crossing the threshold is the whole signal.
   * Steady state is `{ pending: 0, oldestAgeSeconds: 0 }`.
   */
  inboundBacklog: { pending: number; oldestAgeSeconds: number; alerting: boolean };
  /** Present only when degraded — what still works, in one line. */
  detail?: string;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: IORedis,
  ) {}

  /** Liveness — the process is up. Deliberately touches nothing else. */
  @Get()
  live(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness — dependencies are reachable.
   *
   * Kept separate from liveness on purpose: if a dependency blips we do not want the
   * platform to kill and restart the process. A restart does not fix someone else's
   * database.
   *
   * **The two dependencies are not equivalent, and the status code reflects that.**
   *
   *   Database unreachable → 503. Nothing can be stored, so a webhook routed here is
   *     lost outright. Better to fail readiness and let another instance take it.
   *
   *   Redis unreachable → **200, `degraded`**. This is deliberate and is the whole
   *     point of the outbox: the API can still validate signatures, store the inbound
   *     message as PENDING, and honour STOP synchronously. Failing readiness would
   *     pull the instance out of rotation and stop webhook ingestion entirely —
   *     turning a recoverable delay into permanent data loss, since Twilio only
   *     retries so many times. The body says `degraded` so a dashboard can see it;
   *     the code stays 200 so traffic keeps arriving.
   */
  @Get('ready')
  async ready(): Promise<Readiness> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);

    const empty = { pending: 0, oldestAgeSeconds: 0, alerting: false };

    if (database === 'unreachable') {
      throw new ServiceUnavailableException({
        status: 'degraded',
        database,
        redis,
        inboundBacklog: empty,
        detail: 'Database unreachable — cannot accept webhooks.',
      } satisfies Readiness);
    }

    const inboundBacklog = await this.inboundBacklog();

    if (redis === 'unreachable' || inboundBacklog.alerting) {
      return {
        status: 'degraded',
        database,
        redis,
        inboundBacklog,
        detail:
          redis === 'unreachable'
            ? 'Redis unreachable — webhooks are still accepted and stored, STOP is honoured, ' +
              'replies are queued as PENDING and re-driven by the reconciler when Redis returns.'
            : `${inboundBacklog.pending} inbound repl(ies) pending, oldest ` +
              `${inboundBacklog.oldestAgeSeconds}s — customers are waiting on a response.`,
      };
    }

    return { status: 'ok', database, redis, inboundBacklog };
  }

  /**
   * How far behind the inbound pipeline is.
   *
   * One indexed query against `(processing_status, created_at)`, which normally seeks
   * into an empty range and returns nothing — cheap enough to run on every readiness
   * probe. Unscoped by necessity: this is a system-wide operational question, not one
   * asked on behalf of a tenant.
   *
   * A failure here must never fail readiness. Not knowing the backlog is a monitoring
   * gap; refusing traffic over it would be an outage.
   */
  private async inboundBacklog(): Promise<Readiness['inboundBacklog']> {
    try {
      const oldest = await withTimeout(
        this.prisma.unscoped.message.findFirst({
          where: { direction: 'INBOUND', processingStatus: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        PROBE_TIMEOUT_MS,
      );
      if (!oldest) return { pending: 0, oldestAgeSeconds: 0, alerting: false };

      const pending = await withTimeout(
        this.prisma.unscoped.message.count({
          where: { direction: 'INBOUND', processingStatus: 'PENDING' },
        }),
        PROBE_TIMEOUT_MS,
      );
      const ageMs = Date.now() - oldest.createdAt.getTime();
      return {
        pending,
        oldestAgeSeconds: Math.round(ageMs / 1000),
        alerting: ageMs >= BACKLOG_ALERT_AFTER_MS,
      };
    } catch {
      return { pending: 0, oldestAgeSeconds: 0, alerting: false };
    }
  }

  private async checkDatabase(): Promise<'ok' | 'unreachable'> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS);
      return 'ok';
    } catch {
      return 'unreachable';
    }
  }

  /**
   * A real command, not `connection.status`.
   *
   * The status field reports what ioredis believes about its socket, which can read
   * `ready` against a Redis that is rejecting writes — an OOM under `noeviction`
   * being exactly the case that breaks enqueueing while looking healthy.
   */
  private async checkRedis(): Promise<'ok' | 'unreachable'> {
    try {
      await withTimeout(this.redis.ping(), PROBE_TIMEOUT_MS);
      return 'ok';
    } catch {
      return 'unreachable';
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
