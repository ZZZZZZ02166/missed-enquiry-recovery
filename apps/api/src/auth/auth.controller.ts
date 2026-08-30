import { Body, Controller, Get, Logger, Post, Query, Res, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { env } from '../config/env';
import { AuthService, safeRedirect, type AuthenticatedSession } from './auth.service';
import { clearSessionCookieHeader, sessionCookieHeader } from './cookies';
import { Session, SessionGuard } from './session.guard';
import { SESSION_TTL_MS } from './tokens';

/**
 * The authentication endpoints.
 *
 * Four routes and only one of them is interesting. `/auth/callback` is the one an
 * unauthenticated stranger can reach with a guessable-looking URL, so it carries the
 * weight — the other three are either behind the guard or deliberately inert.
 */

class RequestLinkDto {
  /**
   * Validated as an email so the obvious junk is rejected before a database read, and
   * length-capped because an unbounded string reaching a `findUnique` is free work for
   * anyone who wants to send it.
   */
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

class CallbackQuery {
  @IsString()
  @MaxLength(200)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  next?: string;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

  /**
   * Ask for a link by email.
   *
   * **Always 202, always the same body.** Whether the address belongs to an account is
   * not something an unauthenticated caller gets to learn: a 404 here is an
   * account-enumeration oracle, and this product's customers are listed on Google Maps
   * with their business email. The response is identical for a real owner and a stranger
   * guessing.
   *
   * Note what this does *not* do yet: send anything. Delivery is the notification
   * module's job and the address is an email, not an SMS — so until an email transport
   * exists this mints the link and logs that it did. That is a deliberate stub and it is
   * called out here rather than hidden behind a silent success.
   */
  @Post('request-link')
  async requestLink(@Body() body: RequestLinkDto): Promise<{ status: string }> {
    const link = await this.auth.requestLinkByEmail(body.email);

    if (link) this.deliver(link);
    return { status: 'accepted' };
  }

  /**
   * Where a minted link is supposed to go, and currently does not.
   *
   * **There is no email transport yet.** The owner's real path is the magic link inside
   * every lead SMS (D6), so this form is a fallback — but a fallback that shows "check
   * your messages" and then sends nothing is worse than no form at all, because the
   * person waits.
   *
   * Until a transport exists, the two environments behave differently on purpose:
   *
   * - **Development** prints the link at `warn`, where it is actually visible, so a
   *   developer can complete a login locally. It is prefixed loudly because it *is* a
   *   live credential sitting in a terminal.
   * - **Production** logs that a link was requested and could not be delivered, and
   *   deliberately does **not** include it. A credential in a production log is a
   *   credential in whatever aggregates that log. The alert is greppable so this shows up
   *   as an operational gap rather than as silence.
   */
  private deliver(link: string): void {
    if (env.NODE_ENV === 'production') {
      this.logger.error(
        `${EMAIL_TRANSPORT_MISSING} A sign-in link was minted but not delivered: no email ` +
          'transport is configured. The requester is waiting and will receive nothing.',
      );
      return;
    }

    this.logger.warn(`[dev only] No email transport — sign-in link: ${link}`);
  }

  /**
   * Exchange a magic-link token for a session, then send the browser onward.
   *
   * A **GET that mutates**, which is normally wrong and is right here: the request is a
   * top-level navigation from an SMS app, and there is no way to make a phone issue a
   * POST by tapping a link. The mutation is idempotent in the only way that matters —
   * `consumeMagicLink` is a compare-and-set, so the link-preview fetch that beats the
   * human to it consumes the token and the human's tap fails closed rather than logging
   * somebody in twice.
   *
   * Redirects rather than returning JSON, because the caller is a browser mid-navigation
   * and the destination is a dashboard page.
   */
  @Get('callback')
  async callback(@Query() query: CallbackQuery, @Res() res: Response): Promise<void> {
    const cookie = await this.auth.consumeMagicLink(query.token);

    if (!cookie) {
      // No detail in the destination — "expired" and "already used" and "never existed"
      // are the same page. The dashboard offers to send a fresh link.
      res.redirect(302, `${webBase()}/auth/expired`);
      return;
    }

    res.setHeader('Set-Cookie', sessionCookieHeader(cookie, SESSION_TTL_MS));
    // `next` came back from our own minting, but it round-tripped through a URL a user
    // controls, so it is re-validated here rather than trusted. Same rule as
    // `safeRedirect`: a path, on our site, or the root.
    res.redirect(302, `${webBase()}${safeRedirect(query.next ?? '/')}`);
  }

  /**
   * Who am I.
   *
   * The dashboard's first call on load: it decides between rendering the app and
   * redirecting to the sign-in page. Returns the tenant so the client never has to
   * infer or store one.
   */
  @Get('me')
  @UseGuards(SessionGuard)
  me(@Session() session: AuthenticatedSession): AuthenticatedSession {
    return session;
  }

  /**
   * Log out everywhere.
   *
   * Bumps `sessionEpoch`, which invalidates **every** outstanding cookie for this user,
   * not only the one presented. That is the right default for a product whose login
   * arrives by SMS and may have been read on a shared or lost phone.
   *
   * The cookie is cleared as well, so the current browser stops sending a value that
   * would now be rejected on every request.
   */
  @Post('logout')
  @UseGuards(SessionGuard)
  async logout(
    @Session() session: AuthenticatedSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string }> {
    await this.auth.revokeSessions(session.userId);
    res.setHeader('Set-Cookie', clearSessionCookieHeader());
    return { status: 'signed_out' };
  }
}

/**
 * Greppable marker for the one thing this controller cannot do.
 *
 * Same convention as `CATALOGUE_ALERT` and `BACKLOG_ALERT`: a constant string with no
 * interpolation, so an alert rule matches it exactly.
 */
export const EMAIL_TRANSPORT_MISSING = 'EMAIL_TRANSPORT_MISSING';

/** The dashboard's origin, without a trailing slash. */
function webBase(): string {
  return env.PUBLIC_WEB_URL.replace(/\/+$/, '');
}
