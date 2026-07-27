import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The database client, shared by the HTTP app and the worker.
 *
 * Prisma 7 requires a driver adapter — the connection string no longer lives in
 * schema.prisma. `prisma.config.ts` configures the CLI; this configures the runtime.
 * Both read DATABASE_URL, so they cannot drift.
 *
 * NOT YET APPLIED: the tenancy assertion extension (docs/decisions.md D8), which
 * throws when a query on a tenant-scoped model has no `businessId` in its where
 * clause. It lands with the first tenant model — `phone_numbers` — because there is
 * nothing for it to guard until then. `Business` and `User` are the tenant root and
 * are legitimately queried without a businessId filter.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
