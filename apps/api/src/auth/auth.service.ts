import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  generateMagicLinkToken,
  hashMagicLinkToken,
  signSession,
  verifySession,
  MAGIC_LINK_TTL_MS,
  SESSION_TTL_MS,
  type SessionClaims,
} from './tokens';

/**
 * Magic links in, sessions out.
 *
 * The owner's primary surface is an SMS with a link in it (`docs/decisions.md` D6). A
 * cleaner on a roof is not going to type a password into a phone, and any flow that asks
 * them to is a flow they abandon. So the link *is* the login.
 *
 * That makes this file the entire authentication boundary, and everything downstream —
 * every tenant-scoped query in the product — depends on `resolveSession` returning the
 * right `businessId` or nothing at all.
 *
 * **`users` is queried unscoped, legitimately.** It is a tenant root: resolving which
 * business a request belongs to necessarily happens before a tenant is known, exactly
 * like the `phone_numbers` lookup on an inbound webhook (D8).
 */

/** A session that has been verified against the database, not just cryptographically. */
export interface AuthenticatedSession {
  userId: string;
  businessId: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint a link for a user we already know exists.
   *
   * Used by the owner-notification job, which has a `businessId` in hand and wants the
   * lead SMS to drop the owner straight into the lead. Returns the URL to embed.
   *
   * Overwrites any outstanding link, which is the intended behaviour: a second link
   * request should not leave the first one working in an old text message.
   */
  async mintLinkForUser(userId: string, redirectPath = '/'): Promise<string> {
    const token = generateMagicLinkToken();

    await this.prisma.unscoped.user.update({
      where: { id: userId },
      data: {
        magicLinkTokenHash: hashMagicLinkToken(token),
        magicLinkExpiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
        magicLinkSentAt: new Date(),
      },
    });

    // **Points at the API, not the dashboard.** `/auth/callback` is a route on this
    // server: it consumes the token, sets the session cookie, and *then* redirects to
    // `PUBLIC_WEB_URL`. Building the link from the web origin instead produces a URL the
    // dashboard has no page for, and the owner taps it and gets a 404.
    //
    // That was the original bug here, and it survived every test because the test
    // scripts rewrote the port before using the link — which is a good reason never to
    // "fix up" a value on the way into a test.
    //
    // The cookie still reaches the dashboard: it is set with `SESSION_COOKIE_DOMAIN`,
    // the registrable domain both hosts share (D9), so a cookie set by a response from
    // `api.example.com` is sent by `app.example.com`.
    return `${env.PUBLIC_API_URL}/auth/callback?token=${token}&next=${encodeURIComponent(safeRedirect(redirectPath))}`;
  }

  /**
   * Mint a link from an email address, for the "email me a link" form.
   *
   * **Returns nothing either way.** Whether the address exists is not something an
   * unauthenticated caller gets to learn — an endpoint that says "no such user" is an
   * account enumeration oracle, and for a product whose customers are listed on Google
   * Maps that is a real disclosure.
   */
  async requestLinkByEmail(email: string): Promise<string | null> {
    const normalised = email.trim().toLowerCase();
    const user = await this.prisma.unscoped.user.findUnique({
      where: { email: normalised },
      select: { id: true },
    });

    if (!user) {
      // Logged, so a genuine support question is answerable, but never returned.
      this.logger.log(`Magic link requested for an unknown address (${mask(normalised)})`);
      return null;
    }
    return this.mintLinkForUser(user.id);
  }

  /**
   * Exchange a magic-link token for a session cookie value, or null.
   *
   * **Single-use is enforced by a compare-and-set, not by a read-then-write.** The
   * `updateMany` carries the hash it expects to find; if two requests race — a link
   * preview fetching the URL a millisecond before the human taps it is the common case,
   * not a hypothetical — exactly one gets `count === 1` and the other gets zero. A
   * read-then-write would let both through.
   */
  async consumeMagicLink(token: string): Promise<string | null> {
    if (!token || token.length === 0) return null;
    const hash = hashMagicLinkToken(token);

    const user = await this.prisma.unscoped.user.findFirst({
      where: { magicLinkTokenHash: hash },
      select: { id: true, businessId: true, sessionEpoch: true, magicLinkExpiresAt: true },
    });

    if (!user) {
      this.logger.warn('Magic link presented with a token that matches no user');
      return null;
    }
    if (!user.magicLinkExpiresAt || user.magicLinkExpiresAt.getTime() <= Date.now()) {
      this.logger.log(`Magic link for user ${user.id} has expired`);
      return null;
    }

    const claimed = await this.prisma.unscoped.user.updateMany({
      // The hash in the `where` is what makes this a claim rather than an overwrite.
      where: { id: user.id, magicLinkTokenHash: hash },
      data: {
        magicLinkTokenHash: null,
        magicLinkExpiresAt: null,
        magicLinkSentAt: null,
        lastLoginAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      this.logger.warn(`Magic link for user ${user.id} was already consumed`);
      return null;
    }

    return this.issueSession({
      userId: user.id,
      businessId: user.businessId,
      epoch: user.sessionEpoch,
    });
  }

  /** Sign a session cookie for an already-authenticated user. */
  issueSession(input: { userId: string; businessId: string; epoch: number }): string {
    const claims: SessionClaims = {
      userId: input.userId,
      businessId: input.businessId,
      epoch: input.epoch,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    return signSession(claims, env.SESSION_SECRET);
  }

  /**
   * Verify a cookie and confirm it has not been revoked.
   *
   * Two checks, and the second is the reason this is not a pure function. The signature
   * proves the cookie is ours and unmodified; the epoch proves it has not been revoked
   * since. Without the database read, "log out everywhere" would be a button that does
   * nothing for thirty days.
   *
   * The cost is one indexed primary-key read per authenticated request, which is the
   * price of revocability being real.
   */
  async resolveSession(cookie: string | undefined): Promise<AuthenticatedSession | null> {
    if (!cookie) return null;

    const verified = verifySession(cookie, env.SESSION_SECRET);
    if (!verified.valid) {
      // Debug, not warn: an expired cookie is what every returning visitor presents
      // after thirty days, and logging it loudly would bury the signal that matters.
      this.logger.debug(`Session rejected: ${verified.reason}`);
      return null;
    }

    const user = await this.prisma.unscoped.user.findUnique({
      where: { id: verified.claims.userId },
      select: { id: true, businessId: true, sessionEpoch: true },
    });

    if (!user) return null;
    if (user.sessionEpoch !== verified.claims.epoch) {
      this.logger.log(`Session for user ${user.id} was revoked (epoch moved)`);
      return null;
    }

    // **`businessId` comes from the database, not from the cookie** — even though the
    // cookie's copy is signed and would be safe to trust. If a user is ever moved between
    // businesses, a signed-but-stale cookie would otherwise keep reading the old tenant's
    // data until it expired. Rule 1 says the tenant comes from the session; this makes
    // "the session" mean the current state of the world.
    return { userId: user.id, businessId: user.businessId };
  }

  /**
   * Revoke every session this user holds.
   *
   * Incrementing the epoch is the whole mechanism — there is no session table to delete
   * from, which is what makes stateless cookies affordable. `increment` rather than
   * read-modify-write, so two concurrent logouts cannot land on the same value.
   */
  async revokeSessions(userId: string): Promise<void> {
    await this.prisma.unscoped.user.update({
      where: { id: userId },
      data: { sessionEpoch: { increment: 1 } },
    });
    this.logger.log(`All sessions revoked for user ${userId}`);
  }
}

/**
 * A redirect target that cannot leave our own site.
 *
 * `next` exists so a lead SMS drops the owner on the lead itself rather than the inbox.
 * It is also, unavoidably, a redirect target inside an unauthenticated URL — the classic
 * open-redirect surface, and the classic phishing lever: a link on *our* domain that
 * lands on somebody else's login page borrows all of our credibility.
 *
 * **`startsWith('/')` is not enough**, and that was a real bug here, caught by its own
 * test. `//evil.example` starts with a slash and is a *protocol-relative* URL — a browser
 * resolves it to `https://evil.example`. Browsers also normalise backslashes to slashes,
 * so `/\evil.example` and `\\evil.example` reach the same place. And `/javascript:alert(1)`
 * is a path by this rule but a scheme once a browser has stripped the leading slash.
 *
 * So: must start with a single slash, must not begin with two slash-ish characters, must
 * contain no backslash, and must not carry a scheme. Anything else falls back to the root
 * — a wrong landing page is a minor annoyance, an open redirect is a security incident.
 *
 * Exported because the callback re-validates on the way out. `next` round-trips through a
 * URL the user controls, so it is checked again on return rather than trusted because we
 * minted it — but by calling *this* function, not a copy of it. Writing the same
 * validator twice is what produced the GSM-7 label bug in step 89, where the second copy
 * silently omitted a step the first had already been fixed for.
 */
export function safeRedirect(path: string): string {
  const candidate = (path ?? '').trim();
  if (!candidate.startsWith('/')) return '/';
  if (/^[/\\]{2}/.test(candidate)) return '/';
  if (candidate.includes('\\')) return '/';
  // A scheme anywhere in the remainder, not just at the front: browsers strip leading
  // slashes before resolving, so "/javascript:..." is not the path it appears to be.
  if (/[a-z][a-z0-9+.-]*:/i.test(candidate)) return '/';
  return candidate;
}

/** `owner@example.com` -> `o***@example.com`. Enough to identify, not enough to leak. */
function mask(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}
