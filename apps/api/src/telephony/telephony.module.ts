import { Module } from '@nestjs/common';
import { CallsModule } from '../calls/calls.module';
import { TwilioSignatureGuard } from './twilio-signature.guard';
import { VoiceController } from './voice.controller';
import { WebhookEventsService } from './webhook-events.service';

/**
 * Everything that talks to Twilio.
 *
 * `PrismaService` is not imported here — `PrismaModule` is `@Global()`, so it is
 * already available. That is the one global module in the codebase and the exception
 * rather than the pattern.
 *
 * The signature guard is a provider rather than a global guard on purpose: it must
 * apply to webhook routes and nothing else. Registering it globally would put it in
 * front of `/health` and every future dashboard route, where a Twilio signature is
 * meaningless and would reject all traffic.
 *
 * `WebhookEventsService` is exported because the calls and conversations modules will
 * need to mark events processed once the queue exists. Nothing else here is exported:
 * the controllers are entry points, and the guard is only meaningful alongside them.
 */
/**
 * Imports `CallsModule` for `CallsService`, which turns an authenticated webhook
 * into a `Call` and decides whether to recover.
 *
 * The dependency points this way — telephony depends on calls, not the reverse —
 * because `CallsService` knows nothing about Twilio. It takes already-normalised
 * values and returns a decision, which keeps the recovery logic testable without a
 * webhook and makes it reusable if calls ever arrive from somewhere other than
 * Twilio.
 */
@Module({
  imports: [CallsModule],
  controllers: [VoiceController],
  providers: [WebhookEventsService, TwilioSignatureGuard],
  exports: [WebhookEventsService],
})
export class TelephonyModule {}
