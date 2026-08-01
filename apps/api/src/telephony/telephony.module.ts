import { Module } from '@nestjs/common';
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
@Module({
  controllers: [VoiceController],
  providers: [WebhookEventsService, TwilioSignatureGuard],
  exports: [WebhookEventsService],
})
export class TelephonyModule {}
