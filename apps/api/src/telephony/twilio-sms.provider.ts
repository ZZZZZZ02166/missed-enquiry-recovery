import { Injectable, Logger } from '@nestjs/common';
import { Twilio } from 'twilio';
import { assertSendable } from '../common/gsm7';
import { env } from '../config/env';
import {
  PERMANENT_ERROR_CODES,
  PermanentSendError,
  type LookupLineType,
  type LookupResult,
  type SendSmsParams,
  type SendSmsResult,
  type SmsProvider,
} from './sms.provider';

/**
 * The real Twilio adapter.
 *
 * Everything Twilio-specific lives behind the `SmsProvider` seam: the SDK client,
 * the error-code taxonomy, and the Lookup response shape. Nothing above this file
 * imports `twilio`, which is what makes the rest of the send path testable with the
 * fake.
 */

/** Twilio Lookup line types, mapped onto ours. Unknown values fall back rather than throw. */
const LINE_TYPE_MAP: Record<string, LookupLineType> = {
  mobile: 'mobile',
  landline: 'landline',
  voip: 'voip',
  fixedVoip: 'fixedVoip',
  nonFixedVoip: 'nonFixedVoip',
  tollFree: 'tollFree',
};

/** The shape of a Twilio SDK error. It is not exported by the package as a type. */
interface TwilioRestError {
  code?: number;
  status?: number;
  message?: string;
}

function isTwilioError(error: unknown): error is TwilioRestError {
  return typeof error === 'object' && error !== null && 'code' in error;
}

@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly client: Twilio;

  constructor() {
    if (!env.TWILIO_ACCOUNT_SID) {
      throw new Error(
        'TwilioSmsProvider requires TWILIO_ACCOUNT_SID. ' +
          'Bind FakeSmsProvider instead when Twilio is not configured.',
      );
    }

    // API key + secret rather than the auth token, so a leaked credential can be
    // revoked individually. The auth token stays reserved for signature validation,
    // where it cannot be substituted (docs/twilio-setup.md §6).
    const useApiKey = Boolean(env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET);
    this.client = useApiKey
      ? new Twilio(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
          accountSid: env.TWILIO_ACCOUNT_SID,
        })
      : new Twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

    this.logger.log(
      `Twilio SMS provider active (${useApiKey ? 'API key' : 'auth token — prefer an API key'})`,
    );
  }

  /**
   * Send an SMS.
   *
   * Asserts GSM-7 and one segment *before* calling Twilio. Failing locally costs
   * nothing; a UCS-2 message that reaches Twilio is billed at three times the price
   * and there is no way to un-send it.
   */
  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    const info = assertSendable(params.body, `send to ${params.to}`);

    try {
      const message = await this.client.messages.create({
        to: params.to,
        from: params.from,
        body: params.body,
        ...(params.statusCallbackUrl ? { statusCallback: params.statusCallbackUrl } : {}),
      });

      return {
        providerMessageSid: message.sid,
        // 'queued' at this point; delivery status arrives later by webhook.
        status: message.status ?? 'queued',
        // Twilio reports segments as a string, and only sometimes. Our own count is
        // authoritative for cost reporting because it is computed the same way for
        // every message, sent or not.
        segments: Number.parseInt(message.numSegments ?? '', 10) || info.segments,
      };
    } catch (error) {
      throw this.classify(error, params.to);
    }
  }

  /**
   * Twilio Lookup v2 — line type, so we never text a landline.
   *
   * A landline send fails at the carrier and is billed anyway. At ~US$0.008 a lookup
   * this is cheaper than one wasted send, and the result is cached on `customers` so
   * a number is only ever paid for once.
   */
  async lookup(phoneE164: string): Promise<LookupResult> {
    try {
      const result = await this.client.lookups.v2
        .phoneNumbers(phoneE164)
        .fetch({ fields: 'line_type_intelligence' });

      const raw = (result.lineTypeIntelligence as { type?: string } | undefined)?.type;
      return {
        valid: result.valid ?? false,
        // Indexed with a fallback key rather than `raw && ...`: an empty string is
        // falsy but not nullish, so `(raw && MAP[raw]) ?? 'unknown'` would return ''
        // and quietly produce an invalid line type.
        lineType: LINE_TYPE_MAP[raw ?? ''] ?? 'unknown',
      };
    } catch (error) {
      // A failed lookup must not block a send. `unknown` is the honest answer, and
      // the send path already treats it as "proceed" — the alternative is refusing to
      // text anyone whenever Lookup has a bad day.
      this.logger.warn(
        `Lookup failed for ${phoneE164}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { valid: false, lineType: 'unknown' };
    }
  }

  /**
   * Turn an SDK error into either a permanent or a retryable failure.
   *
   * The distinction decides whether BullMQ retries. Retrying a permanent failure
   * burns four more API calls to be rejected identically and buries the cause; not
   * retrying a transient one loses a lead to a network blip.
   */
  private classify(error: unknown, to: string): Error {
    if (!isTwilioError(error) || typeof error.code !== 'number') {
      return error instanceof Error ? error : new Error(String(error));
    }

    const { code, message = 'unknown error' } = error;

    if (PERMANENT_ERROR_CODES.has(code)) {
      // 21408 is a configuration fault, not a bad recipient: Australia is not enabled
      // on the account's geo permissions. It looks exactly like a code bug and will
      // fail for every send, so it is logged at error rather than left to a
      // per-message failure count.
      if (code === 21408) {
        this.logger.error(
          `Twilio 21408: sending to this region is not enabled on the account. ` +
            `Enable Australia under Messaging → Geo Permissions (docs/twilio-setup.md §2).`,
        );
      }
      return new PermanentSendError(code, message);
    }

    this.logger.warn(`Transient Twilio error ${code} sending to ${to}: ${message}`);
    return new Error(`Twilio ${code}: ${message}`);
  }
}
