import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The cryptography behind magic links and sessions.
 *
 * Pure and dependency-free — no Nest, no Prisma, no environment. Everything it needs is
 * passed in, so every property below is testable without standing anything up, which for
 * security code is the difference between "we believe this" and "this is checked".
 *
 * Two different things live here and they must not be confused:
 *
 *   - A **magic-link token** is a random secret we send to a person. It is stored hashed,
 *     used once, and expires in minutes.
 *   - A **session cookie** is a signed statement we send to a browser. It is not stored
 *     at all; it carries its own claims and its own signature.
 *
 * The first is a bearer credential, the second is an assertion. Conflating them is how
 * systems end up with sessions that cannot be revoked or links that never expire.
 */

/**
 * 32 bytes from the OS CSPRNG, base64url.
 *
 * Not `Math.random`, not a uuid, not a timestamp with a counter. 256 bits of real entropy
 * means the link cannot be guessed even at unlimited request rates, which matters because
 * the callback endpoint is necessarily unauthenticated — guessing is the only attack it
 * has to survive.
 */
export function generateMagicLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The value stored in `users.magicLinkTokenHash`.
 *
 * Plain SHA-256, deliberately, and this is the one place where "just hash it" is right
 * rather than lazy. A password needs a slow KDF because it has perhaps 40 bits of entropy
 * and a human is going to reuse it. This token has 256 bits from a CSPRNG and a lifetime
 * of minutes: there is no dictionary to run and no reuse to protect. Slow hashing here
 * would only make the login endpoint a denial-of-service amplifier.
 */
export function hashMagicLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** How long a magic link works for. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/**
 * How long a session lasts.
 *
 * Thirty days, because the owner is a sole trader checking a lead on a phone between
 * jobs, and making them re-request a link every week is how a product stops being opened.
 * Revocation is `sessionEpoch`, not expiry.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What a session cookie asserts. */
export interface SessionClaims {
  userId: string;
  /**
   * The tenant. Read from here and from nowhere else on an authenticated request —
   * CLAUDE.md rule 1 — which is why it is signed rather than looked up per request.
   */
  businessId: string;
  /** Must match `users.sessionEpoch`, or the session has been revoked. */
  epoch: number;
  /** Unix milliseconds. */
  expiresAt: number;
}

/**
 * Sign a session as `payload.signature`, both base64url.
 *
 * A hand-rolled token rather than a JWT library, and that is a considered choice for this
 * shape of problem: JWT's flexibility is its weakness — `alg: none`, algorithm confusion,
 * and a dozen claim conventions nobody validates. There is exactly one algorithm here,
 * the verifier does not read one from the token, and the claim set is four fields defined
 * in this file. Nothing to confuse.
 */
export function signSession(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Why a cookie was rejected. Logged, never shown — each one aids an attacker. */
export type SessionRejection = 'malformed' | 'bad_signature' | 'expired';

export type SessionVerification =
  | { valid: true; claims: SessionClaims }
  | { valid: false; reason: SessionRejection };

/**
 * Verify and decode a session cookie.
 *
 * **The signature is checked before the payload is parsed.** That ordering is the point:
 * `JSON.parse` on attacker-controlled bytes is a place to be careful, and there is no
 * reason to go there until the bytes are proven to be ours.
 */
export function verifySession(cookie: string, secret: string): SessionVerification {
  const parts = (cookie ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: 'malformed' };
  const [payload, signature] = parts as [string, string];

  if (!constantTimeEquals(signature, sign(payload, secret))) {
    return { valid: false, reason: 'bad_signature' };
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // A validly signed cookie can still be structurally wrong if it was minted by an older
  // version of this code. Every field is checked rather than trusted.
  if (
    typeof claims.userId !== 'string' || claims.userId.length === 0 ||
    typeof claims.businessId !== 'string' || claims.businessId.length === 0 ||
    typeof claims.epoch !== 'number' || !Number.isInteger(claims.epoch) ||
    typeof claims.expiresAt !== 'number' || !Number.isFinite(claims.expiresAt)
  ) {
    return { valid: false, reason: 'malformed' };
  }

  if (claims.expiresAt <= Date.now()) return { valid: false, reason: 'expired' };

  return { valid: true, claims };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Compare two strings without leaking where they diverge.
 *
 * `a === b` on a signature returns as soon as a byte differs, and the timing of that
 * return is a measurable oracle an attacker can walk one byte at a time. `timingSafeEqual`
 * requires equal lengths, so a length mismatch is answered first — that leaks only the
 * length, which is fixed for a SHA-256 HMAC and therefore reveals nothing.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
