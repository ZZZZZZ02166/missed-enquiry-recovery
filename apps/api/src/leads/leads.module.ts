import { Module } from '@nestjs/common';
import { LeadsService } from './leads.service';

/**
 * Leads.
 *
 * No controllers yet — the dashboard is the review surface and does not exist. The
 * primary owner surface is an SMS with a magic link (`docs/decisions.md`), which
 * belongs to notifications, not here.
 *
 * `LeadsService` is exported because the writer is a job processor: leads are created
 * as a side effect of advancing a conversation, on the worker, never in a webhook.
 */
@Module({
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
