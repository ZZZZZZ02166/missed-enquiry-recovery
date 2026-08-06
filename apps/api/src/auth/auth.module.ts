import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionGuard } from './session.guard';

/**
 * Authentication.
 *
 * `AuthService` and `SessionGuard` are both exported because every other module that
 * serves an owner-facing route needs the guard, and the notification job needs the
 * service to mint the magic link it puts in a lead SMS.
 *
 * The guard is a provider here rather than a global `APP_GUARD`, deliberately. A global
 * guard would protect the Twilio webhooks too — which authenticate by signature, not by
 * cookie — so it would have to be opted out of with a `@Public()` decorator on the
 * routes that matter most. Opt-out security fails open: forget the decorator and a
 * webhook breaks loudly, but forget it in the other direction and a route is silently
 * unprotected. Opt-in with `@UseGuards(SessionGuard)` fails closed, and the guard's own
 * `@Session()` decorator throws if it was left off.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [AuthService, SessionGuard],
  exports: [AuthService, SessionGuard],
})
export class AuthModule {}
