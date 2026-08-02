import { Module } from '@nestjs/common';
import { CallsService } from './calls.service';
import { SuppressionsService } from './suppressions.service';

/**
 * Calls and the recovery decision.
 *
 * No controllers. Calls arrive through Twilio webhooks, which belong to
 * `TelephonyModule` — this module owns what happens *after* a webhook is
 * authenticated and recorded. The dashboard's read-only call list will add a
 * controller here later; there is nothing to expose yet.
 *
 * `SuppressionsService` lives here rather than in its own module because it exists
 * to answer one question — "may we send to this caller?" — which is a step in the
 * recovery decision. Splitting it out would create a module whose only consumer is
 * this one.
 *
 * Both are exported: `TelephonyModule` needs `CallsService` to record inbound calls,
 * and the messaging path will need `SuppressionsService` directly to record a STOP
 * reply and to check before every send.
 */
@Module({
  providers: [CallsService, SuppressionsService],
  exports: [CallsService, SuppressionsService],
})
export class CallsModule {}
