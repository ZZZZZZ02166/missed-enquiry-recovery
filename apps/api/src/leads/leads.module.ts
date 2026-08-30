import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/**
 * Leads.
 *
 * `LeadsController` is the destination of the magic link in every lead SMS — read the
 * inbox, open one lead, record whether it was won. The primary owner surface is still
 * the SMS itself (`docs/decisions.md` D6); this is the review surface behind it.
 *
 * `LeadsService` is exported because the *writer* is a job processor: leads are created
 * as a side effect of advancing a conversation, on the worker, never in a webhook. So
 * the service has two very different callers — a job that writes and a controller that
 * reads — and only the controller is tenant-guarded by HTTP session.
 */
@Module({
  imports: [AuthModule],
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
