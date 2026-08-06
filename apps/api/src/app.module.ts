import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConversationsModule } from './conversations/conversations.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { LeadsModule } from './leads/leads.module';
import { PrismaModule } from './prisma/prisma.module';
import { TelephonyModule } from './telephony/telephony.module';

/**
 * The root module, shared by both entrypoints — `main.ts` serves it over HTTP,
 * `worker.ts` instantiates it without a listener (docs/decisions.md D7).
 *
 * Importing TelephonyModule here is what makes the Twilio webhook routes exist on
 * the running application. They are publicly reachable and unauthenticated by
 * necessity — Twilio has to be able to call them — so TwilioSignatureGuard is the
 * only thing standing in front of them.
 *
 * The worker loads this same graph. That is intentional: it needs the telephony
 * providers to process jobs, and the controllers are simply never routed because
 * `worker.ts` uses `createApplicationContext` and opens no port.
 *
 * Feature modules land here as they are built:
 *   auth, businesses, services, calls, conversations, leads, notifications, jobs
 */
@Module({
  imports: [PrismaModule, AuthModule, JobsModule, TelephonyModule, ConversationsModule, LeadsModule],
  controllers: [HealthController],
})
export class AppModule {}
