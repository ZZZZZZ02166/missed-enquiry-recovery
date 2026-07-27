import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

/**
 * The root module, shared by both entrypoints — `main.ts` serves it over HTTP,
 * `worker.ts` instantiates it without a listener (docs/decisions.md D7).
 *
 * Feature modules land here as they are built:
 *   auth, businesses, services, telephony, calls, conversations, leads,
 *   notifications, jobs
 */
@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
