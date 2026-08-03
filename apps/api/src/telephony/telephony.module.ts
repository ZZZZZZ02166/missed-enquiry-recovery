import { Module } from '@nestjs/common';
import { CallsModule } from '../calls/calls.module';
import { MessagesController } from './messages.controller';
import { smsProviderFactory } from './sms-provider.factory';
import { SMS_PROVIDER } from './sms.provider';
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
 *
 * `CallsModule` is imported for `CallsService`, which turns an authenticated webhook
 * into a `Call` and decides whether to recover. The dependency points this way —
 * telephony depends on calls, not the reverse — because `CallsService` knows nothing
 * about Twilio. It takes already-normalised values and returns a decision, which keeps
 * the recovery logic testable without a webhook and reusable if calls ever arrive from
 * somewhere other than Twilio.
 *
 * `SMS_PROVIDER` is exported because the recovery job — which lives in the worker,
 * not here — is what actually sends. Telephony owns the Twilio boundary; other
 * modules consume it through the interface and never import the SDK. The factory
 * runs once, at module construction, and logs whether messages will be delivered or
 * only recorded. That line is the answer to "why did no text arrive?", so it must
 * appear in every boot.
 */
@Module({
  imports: [CallsModule],
  // Both webhook surfaces. `MessagesController` needs `SuppressionsService`, which
  // arrives via the `CallsModule` import above — the same import that gives
  // `VoiceController` its `CallsService`.
  controllers: [VoiceController, MessagesController],
  providers: [WebhookEventsService, TwilioSignatureGuard, smsProviderFactory],
  exports: [WebhookEventsService, SMS_PROVIDER],
})
export class TelephonyModule {}
