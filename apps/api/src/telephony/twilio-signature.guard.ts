import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { validateRequest } from 'twilio';
import { env } from '../config/env';

/**
 * Rejects any request to a Twilio webhook that does not carry a valid
 * `X-Twilio-Signature`.
 *
 * These endpoints are unauthenticated and publicly reachable — they have to be, so
 * Twilio can reach them. The signature is the only thing distinguishing a real
 * delivery from anyone who can guess the URL, and a forged one would let a stranger
 * create leads, trigger SMS at our cost, and put text in front of a business's
 * customers.
 *
 * Runs before anything with a side effect (`.claude/skills/twilio/SKILL.md` §2).
 */
@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  private readonly logger = new Logger(TwilioSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    const authToken = env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      // The token is optional in env.ts so the app can boot before the AU
      // regulatory bundle clears. That must not become an open door: with no token
      // there is no way to verify anything, so we refuse rather than pass through.
      this.logger.error(
        'TWILIO_AUTH_TOKEN is not set — refusing all webhook traffic. ' +
          'Signature validation cannot be skipped (docs/twilio-setup.md §6).',
      );
      throw forbidden();
    }

    const signature = req.header('x-twilio-signature');
    if (!signature) {
      this.logger.warn(
        `Missing X-Twilio-Signature on ${req.method} ${req.originalUrl} from ${clientIp(req)}`,
      );
      throw forbidden();
    }

    const url = buildWebhookUrl(req.originalUrl);

    // Form-encoded webhooks are signed over URL + alphabetically sorted params, so
    // this needs the *parsed* body, not the raw one (CLAUDE.md rule 7).
    const params = (req.body ?? {}) as Record<string, unknown>;

    if (!validateRequest(authToken, signature, url, params)) {
      // The reconstructed URL is in the log on purpose. When this fires in a new
      // environment the cause is almost always that this string does not match what
      // Twilio actually called, and without seeing it the failure is opaque.
      this.logger.warn(
        `Invalid Twilio signature. reconstructedUrl=${url} paramCount=${Object.keys(params).length} ip=${clientIp(req)}`,
      );
      throw forbidden();
    }

    return true;
  }
}

/**
 * Rebuild the URL Twilio signed.
 *
 * Built from the pinned `PUBLIC_API_URL` rather than from `req.protocol` and
 * `req.host`. Behind Railway, Render or ngrok, `req.protocol` reports `http` while
 * Twilio called `https`, so a header-derived URL differs by one character and every
 * signature fails with no useful error. `trust proxy` fixes that in principle, but
 * it makes correctness depend on a forwarded header we do not control; a pinned
 * value is deterministic and is also what `docs/twilio-setup.md` tells you to
 * configure in the Twilio console, so the two cannot drift.
 *
 * `originalUrl` is used rather than `path` because it retains the query string,
 * which Twilio includes in the signed string.
 */
export function buildWebhookUrl(originalUrl: string, base: string = env.PUBLIC_API_URL): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const suffix = originalUrl.startsWith('/') ? originalUrl : `/${originalUrl}`;
  return `${trimmedBase}${suffix}`;
}

/**
 * 403 with an empty body. Nothing about why it failed goes back over the wire —
 * that detail belongs in our logs, not in a response to an unauthenticated caller
 * probing the endpoint.
 */
function forbidden(): HttpException {
  return new HttpException('', HttpStatus.FORBIDDEN);
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
