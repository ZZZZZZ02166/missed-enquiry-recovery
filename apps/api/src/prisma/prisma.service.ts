import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { tenantGuard } from './tenant-guard';

/**
 * The database client, shared by the HTTP app and the worker.
 *
 * Prisma 7 requires a driver adapter — the connection string no longer lives in
 * schema.prisma. `prisma.config.ts` configures the CLI; this configures the runtime.
 * Both read DATABASE_URL, so they cannot drift.
 *
 * THREE SURFACES, and which one a call site uses is visible at the call site:
 *
 *   prisma.db.*         Guarded. The default. Every tenant-model query must carry
 *                       businessId or it throws (docs/decisions.md D8).
 *
 *   prisma.unscoped.*   The deliberate hole. For the handful of reads that happen
 *                       *before* a tenant is known — resolving a webhook's `To`
 *                       number, looking up a magic-link token. Keep call sites few
 *                       and greppable; a growing list means the guard is being
 *                       worked around rather than satisfied.
 *
 *   prisma.$queryRaw    Raw SQL. Outside the guard by nature, not by omission — the
 *                       extension only sees model operations. Raw queries against
 *                       tenant tables must carry their own WHERE business_id = ...
 *
 * This class does NOT extend PrismaClient. `$extends` returns a *new* client rather
 * than mutating the instance, so inheritance would leave `this` as the unguarded
 * base — the default surface would be the unsafe one, which is exactly backwards.
 * Composition makes the guarded client the default and forces `unscoped` to be
 * asked for by name.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Unguarded base. Private: nothing outside this class may reach it except through
   * `unscoped`, so that every bypass is spelled out at its call site.
   */
  private readonly base = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  /** Guarded client. Use this unless you have a reason not to. */
  readonly db = this.base.$extends(tenantGuard);

  /**
   * Raw SQL passthrough. Deliberately on the root rather than under `db`: raw
   * queries are outside the tenancy guard, and putting them beside the guarded
   * surface would imply a protection that does not apply.
   */
  readonly $queryRaw = this.base.$queryRaw.bind(this.base);
  readonly $executeRaw = this.base.$executeRaw.bind(this.base);

  /**
   * Escape hatch for pre-tenant reads. Named, not incidental — `prisma.unscoped` is
   * greppable, and a review can count the call sites.
   */
  get unscoped(): PrismaClient {
    return this.base;
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    this.logger.log('Database connected (tenant guard active)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /**
   * Transactions run on the guarded client, so every statement inside one is
   * checked too. Exposed explicitly because `db.$transaction` is easy to miss.
   */
  get $transaction(): (typeof this.db)['$transaction'] {
    return this.db.$transaction.bind(this.db);
  }
}
