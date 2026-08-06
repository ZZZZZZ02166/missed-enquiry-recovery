import { SESSION_COOKIE, readCookie, sessionCookieHeader, clearSessionCookieHeader } from './cookies';

/**
 * Cookie handling is parsing attacker-reachable input and emitting security attributes,
 * so it gets a jest spec that runs in CI rather than a scratchpad probe.
 */

describe('readCookie', () => {
  it('reads the session out of a realistic header', () => {
    const header = `theme=dark; ${SESSION_COOKIE}=abc.def; other=1`;
    expect(readCookie(header, SESSION_COOKIE)).toBe('abc.def');
  });

  it('tolerates the shapes real clients send', () => {
    for (const header of [
      `${SESSION_COOKIE}=v`,
      `a=1;${SESSION_COOKIE}=v`, // no space after the semicolon
      `${SESSION_COOKIE}=v;`, // trailing semicolon
      `a=1; ; ${SESSION_COOKIE}=v`, // empty segment
      `  ${SESSION_COOKIE}  =  v  `, // stray whitespace
    ]) {
      expect(readCookie(header, SESSION_COOKIE)).toBe('v');
    }
  });

  it('decodes percent-escapes', () => {
    expect(readCookie(`${SESSION_COOKIE}=a%2Eb`, SESSION_COOKIE)).toBe('a.b');
  });

  it('returns undefined rather than raw bytes for a malformed escape', () => {
    // Returning the raw value would hand the verifier bytes the client did not send.
    expect(readCookie(`${SESSION_COOKIE}=%E0%A4%A`, SESSION_COOKIE)).toBeUndefined();
  });

  it('does not match a different cookie whose name contains ours', () => {
    expect(readCookie(`not_${SESSION_COOKIE}=v`, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(`${SESSION_COOKIE}_old=v`, SESSION_COOKIE)).toBeUndefined();
  });

  it('takes the first when a name appears twice', () => {
    // A duplicated name is a misconfiguration or an attempt to confuse the parser.
    // Browsers take the first; so do we.
    expect(readCookie(`${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second`, SESSION_COOKIE)).toBe('first');
  });

  it('never throws on junk', () => {
    for (const header of ['', ';', '=', '=;', 'novalue', '=novalue', 'a'.repeat(10_000), ';;;;']) {
      expect(() => readCookie(header, SESSION_COOKIE)).not.toThrow();
    }
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});

describe('the Set-Cookie attributes', () => {
  const header = sessionCookieHeader('a.b', 30 * 24 * 60 * 60 * 1000);

  it('is HttpOnly, so an XSS bug cannot exfiltrate a thirty-day login', () => {
    expect(header).toContain('HttpOnly');
  });

  it('is SameSite=Lax — CSRF protection that survives the magic link', () => {
    expect(header).toContain('SameSite=Lax');
    // Strict would drop the cookie on the top-level navigation from an SMS app, so the
    // owner would tap the link and land logged out.
    expect(header).not.toContain('SameSite=Strict');
  });

  it('carries the shared registrable domain from D9', () => {
    expect(header).toMatch(/Domain=/);
  });

  it('sets Max-Age in seconds, not milliseconds', () => {
    expect(header).toContain('Max-Age=2592000');
  });

  it('url-encodes the value', () => {
    expect(sessionCookieHeader('a b', 1000)).toContain('a%20b');
  });

  it('clears with identical attributes, or logout silently does nothing', () => {
    // A browser treats a differing attribute set as a *different* cookie and keeps the
    // original — a logout button that appears to work.
    const cleared = clearSessionCookieHeader();
    const attributesOf = (value: string) =>
      value
        .split('; ')
        .slice(1)
        .filter((part) => !part.startsWith('Max-Age'))
        .sort();

    expect(attributesOf(cleared)).toEqual(attributesOf(header));
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
  });
});
