import { ExecutionContext, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

const TOKEN = 'test_auth_token_12345';
const BASE = 'https://api.example.com';

// These must be set BEFORE the guard's module graph loads.
//
// `config/env.ts` snapshots process.env at module-evaluation time, and ES imports
// are hoisted — a static `import { TwilioSignatureGuard } from './...'` would
// evaluate env.ts first and read whatever the repo .env happens to contain, making
// every case fail with "TWILIO_AUTH_TOKEN is not set". A CommonJS require is not
// hoisted, so it runs after these assignments. (dotenv does not override variables
// already present in process.env, so these win.)
process.env.TWILIO_AUTH_TOKEN = TOKEN;
process.env.PUBLIC_API_URL = BASE;

// The require and the cast are separate statements on purpose: combined, Prettier
// wraps the line and the eslint-disable-next-line comment then points at the wrong
// line, which fails lint in a way that looks unrelated to the change that caused it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const guardModule = require('./twilio-signature.guard');
const { TwilioSignatureGuard, buildWebhookUrl } =
  guardModule as typeof import('./twilio-signature.guard');

const PATH = '/webhooks/twilio/voice/incoming';
const URL = `${BASE}${PATH}`;

/**
 * Twilio's algorithm, implemented independently: the full URL, then every POST
 * param sorted by key and appended as key+value with no separator, HMAC-SHA1,
 * base64.
 *
 * Deliberately not `twilio`'s own signing helper — using the library to both sign
 * and verify would round-trip one implementation against itself and pass even if
 * our understanding of the algorithm were wrong.
 */
function sign(url: string, params: Record<string, string>, token = TOKEN): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

const VALID_PARAMS = {
  CallSid: 'CA00000000000000000000000000000001',
  From: '+61412345678',
  To: '+61391110000',
  CallStatus: 'no-answer',
};

function makeContext(
  headers: Record<string, string>,
  body: unknown,
  originalUrl: string = PATH,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        originalUrl,
        body,
        ip: '203.0.113.7',
        socket: {},
        header: (name: string) => headers[name.toLowerCase()],
      }),
    }),
  } as unknown as ExecutionContext;
}

/** Guards throw HttpException; this pulls out the status without `any`. */
function statusOf(err: unknown): number | undefined {
  return (err as { getStatus?: () => number }).getStatus?.();
}

function expectForbidden(fn: () => unknown): void {
  expect(fn).toThrow();
  try {
    fn();
  } catch (err) {
    expect(statusOf(err)).toBe(403);
    // Empty body: nothing about why it failed goes back to an unauthenticated caller.
    expect((err as { getResponse: () => unknown }).getResponse()).toBe('');
  }
}

describe('TwilioSignatureGuard', () => {
  let guard: InstanceType<typeof TwilioSignatureGuard>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    guard = new TwilioSignatureGuard();
    // Silence and capture. The log content is asserted below — the reconstructed
    // URL appearing in a failure is a documented diagnostic property, not incidental.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('accepts genuine deliveries', () => {
    it('allows a correctly signed request', () => {
      const sig = sign(URL, VALID_PARAMS);
      expect(guard.canActivate(makeContext({ 'x-twilio-signature': sig }, VALID_PARAMS))).toBe(
        true,
      );
    });

    it('is insensitive to param order — the algorithm sorts by key', () => {
      const sig = sign(URL, VALID_PARAMS);
      const reordered = {
        CallStatus: VALID_PARAMS.CallStatus,
        To: VALID_PARAMS.To,
        From: VALID_PARAMS.From,
        CallSid: VALID_PARAMS.CallSid,
      };
      expect(guard.canActivate(makeContext({ 'x-twilio-signature': sig }, reordered))).toBe(true);
    });

    it('allows an empty body when the signature matches it', () => {
      // Status callbacks with no params still have to validate.
      const sig = sign(URL, {});
      expect(guard.canActivate(makeContext({ 'x-twilio-signature': sig }, {}))).toBe(true);
    });

    it('reads the signature header case-insensitively', () => {
      const sig = sign(URL, VALID_PARAMS);
      expect(guard.canActivate(makeContext({ 'x-twilio-signature': sig }, VALID_PARAMS))).toBe(
        true,
      );
    });
  });

  describe('rejects forged and tampered requests', () => {
    const sig = () => sign(URL, VALID_PARAMS);

    it('rejects a changed param value', () => {
      // The attack that matters: repointing a real webhook at a different caller.
      expectForbidden(() =>
        guard.canActivate(
          makeContext({ 'x-twilio-signature': sig() }, { ...VALID_PARAMS, From: '+61400000000' }),
        ),
      );
    });

    it('rejects an injected extra param', () => {
      expectForbidden(() =>
        guard.canActivate(
          makeContext({ 'x-twilio-signature': sig() }, { ...VALID_PARAMS, Evil: '1' }),
        ),
      );
    });

    it('rejects a dropped param', () => {
      expectForbidden(() =>
        guard.canActivate(
          makeContext({ 'x-twilio-signature': sig() }, { CallSid: VALID_PARAMS.CallSid }),
        ),
      );
    });

    it('rejects a valid signature replayed at a different path', () => {
      // The URL is part of the signed string, so a capture from the voice webhook
      // cannot be replayed against the messaging one.
      expectForbidden(() =>
        guard.canActivate(
          makeContext(
            { 'x-twilio-signature': sig() },
            VALID_PARAMS,
            '/webhooks/twilio/messages/incoming',
          ),
        ),
      );
    });

    it('rejects a signature made with a different auth token', () => {
      expectForbidden(() =>
        guard.canActivate(
          makeContext(
            { 'x-twilio-signature': sign(URL, VALID_PARAMS, 'someone_elses_token') },
            VALID_PARAMS,
          ),
        ),
      );
    });

    it('rejects a missing signature header', () => {
      expectForbidden(() => guard.canActivate(makeContext({}, VALID_PARAMS)));
    });

    it('rejects an empty signature header', () => {
      expectForbidden(() =>
        guard.canActivate(makeContext({ 'x-twilio-signature': '' }, VALID_PARAMS)),
      );
    });

    it('rejects a garbage signature without throwing something other than 403', () => {
      expectForbidden(() =>
        guard.canActivate(makeContext({ 'x-twilio-signature': 'not-base64-!!' }, VALID_PARAMS)),
      );
    });

    it('tolerates a missing body', () => {
      // Should be a clean 403, not a TypeError on undefined.
      expectForbidden(() =>
        guard.canActivate(makeContext({ 'x-twilio-signature': sig() }, undefined)),
      );
    });
  });

  describe('diagnostics', () => {
    it('logs the reconstructed URL when a signature fails', () => {
      // Documented property: when this fires in a new environment the cause is
      // almost always that this exact string does not match what Twilio called.
      // Without it in the log the failure is opaque.
      try {
        guard.canActivate(makeContext({ 'x-twilio-signature': 'wrong' }, VALID_PARAMS));
      } catch {
        /* expected */
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(URL);
    });

    it('logs the method and path when the header is missing', () => {
      try {
        guard.canActivate(makeContext({}, VALID_PARAMS));
      } catch {
        /* expected */
      }
      expect(String(warn.mock.calls[0]?.[0])).toContain(PATH);
    });

    it('does not leak the reason in the response body', () => {
      try {
        guard.canActivate(makeContext({ 'x-twilio-signature': 'wrong' }, VALID_PARAMS));
      } catch (err) {
        expect(JSON.stringify((err as { getResponse: () => unknown }).getResponse())).not.toContain(
          'signature',
        );
      }
    });

    it('never logs the auth token', () => {
      try {
        guard.canActivate(makeContext({ 'x-twilio-signature': 'wrong' }, VALID_PARAMS));
      } catch {
        /* expected */
      }
      const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(' ');
      expect(logged).not.toContain(TOKEN);
    });
  });

  describe('buildWebhookUrl', () => {
    it.each([
      ['plain path', PATH, BASE, URL],
      ['trailing slash on base', PATH, `${BASE}/`, URL],
      ['multiple trailing slashes', PATH, `${BASE}///`, URL],
      ['missing leading slash on path', 'webhooks/x', BASE, `${BASE}/webhooks/x`],
      ['query string retained', '/w?a=1&b=2', BASE, `${BASE}/w?a=1&b=2`],
    ])('%s', (_label, path, base, expected) => {
      expect(buildWebhookUrl(path, base)).toBe(expected);
    });

    it('keeps the query string, because Twilio signs it', () => {
      // `req.path` would silently drop it and every signature on a URL with query
      // params would fail.
      expect(buildWebhookUrl('/w?CallSid=CA1', BASE)).toContain('?CallSid=CA1');
    });
  });
});

describe('TwilioSignatureGuard without TWILIO_AUTH_TOKEN', () => {
  it('refuses all traffic rather than passing it through', () => {
    // The token is optional in env.ts so the app can boot before the AU regulatory
    // bundle clears. That convenience must never become an open door.
    const previous = process.env.TWILIO_AUTH_TOKEN;
    jest.resetModules();
    process.env.TWILIO_AUTH_TOKEN = '';

    // resetModules re-instantiates the *whole* graph, including @nestjs/common — so
    // the reloaded guard closes over a different Logger class than the one imported
    // at the top of this file. Spying on the outer Logger silently does nothing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reloadedNest = require('@nestjs/common') as typeof import('@nestjs/common');
    const errorSpy = jest
      .spyOn(reloadedNest.Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const reloadedModule = require('./twilio-signature.guard');
      const reloaded = reloadedModule as typeof import('./twilio-signature.guard');
      const guard = new reloaded.TwilioSignatureGuard();
      const sig = sign(URL, VALID_PARAMS);

      // Even a perfectly valid signature must be rejected: with no token there is
      // nothing to verify against.
      expectForbidden(() =>
        guard.canActivate(makeContext({ 'x-twilio-signature': sig }, VALID_PARAMS)),
      );
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      process.env.TWILIO_AUTH_TOKEN = previous;
      errorSpy.mockRestore();
      jest.resetModules();
    }
  });
});
