import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type AuthenticatedSession } from './auth.service';
import { SESSION_COOKIE, readCookie } from './cookies';

/**
 * The guard that makes CLAUDE.md rule 1 enforceable rather than aspirational.
 *
 * The rule says every query is scoped by a `businessId` taken from the authenticated
 * session, never from anything the client controls. Until now that has been a rule with
 * no mechanism behind it on the HTTP side: `AuthService` could turn a cookie into a
 * tenant, but nothing obliged a controller to ask.
 *
 * This is the mechanism. The guard resolves the session once and attaches it to the
 * request; `@Session()` is the only sanctioned way to read it. A controller that wants a
 * tenant has to take it from the decorator, and the decorator can only produce what the
 * guard put there — so reading `businessId` from a body, a query param or a header is not
 * something you can do by accident. You would have to write code that visibly bypasses
 * this file, which is exactly the property worth having: the wrong thing has to look
 * wrong.
 */

/** What the guard attaches. Deliberately minimal — a tenant and a user, nothing else. */
export interface RequestWithSession extends Request {
  session?: AuthenticatedSession;
}

@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const cookie = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = await this.auth.resolveSession(cookie);

    if (!session) {
      // One message for every failure mode — no cookie, bad signature, expired, revoked,
      // deleted user. The client learns only that it is not authenticated, because
      // distinguishing "expired" from "revoked" from "no such user" tells an attacker
      // which of those they achieved.
      this.logger.debug(`Unauthenticated request to ${request.method} ${request.url}`);
      throw new UnauthorizedException('Not authenticated');
    }

    request.session = session;
    return true;
  }
}

/**
 * The only sanctioned way to read the tenant in a controller.
 *
 * ```ts
 * @UseGuards(SessionGuard)
 * @Get()
 * list(@Session() session: AuthenticatedSession) {
 *   return this.leads.list(session.businessId);
 * }
 * ```
 *
 * **Throws rather than returning undefined when the guard has not run.** That is the
 * important behaviour and it is not defensive noise: a route decorated with `@Session()`
 * but missing `@UseGuards(SessionGuard)` would otherwise hand the controller
 * `undefined`, and `businessId` would arrive as `undefined` in a Prisma `where` clause —
 * which does not error, and does not filter. Prisma treats an undefined filter as absent,
 * so that route would return **every tenant's rows**. Failing loudly at the decorator is
 * the difference between a 500 in development and a cross-tenant data leak in production.
 */
export const Session = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedSession => {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    if (!request.session) {
      throw new Error(
        '@Session() was used on a route without @UseGuards(SessionGuard). ' +
          'Without the guard there is no tenant, and an undefined businessId in a Prisma ' +
          'where clause returns every business’s rows rather than none.',
      );
    }
    return request.session;
  },
);
