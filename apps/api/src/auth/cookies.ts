import { env } from '../config/env';

/**
 * Reading and writing the session cookie.
 *
 * Hand-rolled rather than `cookie-parser`, and that is a small deliberate choice: this
 * application has exactly one cookie, and a dependency that runs on every request —
 * including every unauthenticated Twilio webhook — is supply-chain surface bought for
 * about fifteen lines. The parsing is the boring part; the attributes below are the part
 * that matters, and no library would choose them for us.
 */

export const SESSION_COOKIE = 'mer_session';

/**
 * Read one named cookie out of a `Cookie` header.
 *
 * Deliberately tolerant of the shapes real clients send — no space after a semicolon, a
 * trailing semicolon, an empty segment — and deliberately strict about what it returns:
 * the first match only. A header carrying the same name twice is either a
 * misconfiguration or an attempt to confuse the parser, and taking the first is what
 * browsers do.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;

  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1) continue;
    if (segment.slice(0, separator).trim() !== name) continue;

    const raw = segment.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is not a session. Returning the raw value would hand
      // the verifier bytes the client did not intend to send.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Whether the cookie may carry `Secure`.
 *
 * Browsers reject a `Secure` cookie over plain HTTP, which is every local development
 * setup on `http://localhost`. Deriving it from the public URL rather than `NODE_ENV`
 * means a staging environment served over HTTPS gets the right behaviour without anyone
 * remembering to set a flag — and a production deployment misconfigured onto HTTP loses
 * the attribute loudly rather than silently failing to log anyone in.
 */
function secureCookies(): boolean {
  return env.PUBLIC_API_URL.startsWith('https://');
}

/**
 * The attributes shared by setting and clearing.
 *
 * They must be identical in both, or the browser treats the clear as a *different*
 * cookie, quietly keeps the original, and logout becomes a button that appears to work
 * and does nothing. Building both from one function is what stops them drifting.
 *
 * Each one is load-bearing:
 *
 * - **`HttpOnly`** — script cannot read it, so an XSS bug in the dashboard cannot
 *   exfiltrate a thirty-day login.
 * - **`SameSite=Lax`** — not sent on cross-site POSTs, which is CSRF protection for
 *   every mutating route without a token dance. `Lax` rather than `Strict` because the
 *   magic link arrives from an SMS app: `Strict` drops the cookie on that first
 *   top-level navigation, so the owner would tap the link and land logged out.
 * - **`Domain`** — the shared registrable domain from D9, so `app.example.com` and
 *   `api.example.com` are one site. This is why the `__Host-` prefix is *not* used here:
 *   it forbids a `Domain` attribute outright, which would be stricter but would break
 *   the two-subdomain layout that decision settled on.
 * - **`Path=/`** — the dashboard's routes are not all under one prefix.
 */
function attributes(): string[] {
  const parts = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Domain=${env.SESSION_COOKIE_DOMAIN}`];
  if (secureCookies()) parts.push('Secure');
  return parts;
}

/** The `Set-Cookie` value for a new session. */
export function sessionCookieHeader(value: string, maxAgeMs: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    ...attributes(),
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ].join('; ');
}

/** The `Set-Cookie` value that clears it. Same attributes, empty value, `Max-Age=0`. */
export function clearSessionCookieHeader(): string {
  return [`${SESSION_COOKIE}=`, ...attributes(), 'Max-Age=0'].join('; ');
}
