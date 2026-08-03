import { assertSendable } from '../common/gsm7';

/**
 * The seam between our code and Twilio.
 *
 * Exists from before the first real send, deliberately. Without it every integration
 * test costs money and needs a physical handset, and by the time the SDK is called
 * from six places the seam is expensive to retrofit
 * (`.claude/skills/twilio/SKILL.md` §8).
 *
 * The interface is narrow on purpose: it exposes only what the recovery flow needs,
 * so the fake is small enough to be obviously correct and a second provider — should
 * Twilio ever be replaced — has a short contract to satisfy.
 */

export interface SendSmsParams {
  /** E.164, normalised at the edge. */
  to: string;
  /** E.164. The business's Twilio number. */
  from: string;
  /** GSM-7, one segment. Asserted before the provider is called. */
  body: string;
  /**
   * Where Twilio posts delivery status. Omitted in tests and when a status callback
   * would have nowhere to land.
   */
  statusCallbackUrl?: string;
}

export interface SendSmsResult {
  /** Twilio's `MessageSid` — the idempotency and lookup key for this send. */
  providerMessageSid: string;
  /** `queued` at send time; delivery status arrives later by webhook. */
  status: string;
  segments: number;
}

/** Line type from Twilio Lookup, cached on `customers` so it is paid for once. */
export type LookupLineType =
  'mobile' | 'landline' | 'voip' | 'fixedVoip' | 'nonFixedVoip' | 'tollFree' | 'unknown';

export interface LookupResult {
  valid: boolean;
  lineType: LookupLineType;
}

/**
 * A send that failed for a reason that will not change on retry.
 *
 * Distinguished from a transient failure because the two need opposite handling: a
 * retry of a permanent failure burns four more API calls to be rejected identically,
 * and buries the real cause under a stack of timeouts
 * (`.claude/skills/queues-redis/SKILL.md` §4).
 */
export class PermanentSendError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`Twilio ${code}: ${message}`);
    this.name = 'PermanentSendError';
  }
}

/**
 * Twilio error codes that must never be retried.
 *
 * 21610 is the important one: Twilio maintains its own opt-out list per sending
 * number and rejects sends even when our database believes the number is fine. It is
 * the authoritative signal that the two lists have diverged, and the handler must
 * back-fill a suppression row rather than try again.
 */
export const PERMANENT_ERROR_CODES = new Set([
  21610, // recipient unsubscribed (STOP)
  21211, // invalid `To` number — an E.164 normalisation bug
  21614, // `To` is not a valid mobile — a landline that got past Lookup
  21606, // `From` is not a valid SMS-capable number on this account
  21408, // permission to send to this region not enabled — a config error, alert on it
]);

export interface SmsProvider {
  sendSms(params: SendSmsParams): Promise<SendSmsResult>;
  lookup(phoneE164: string): Promise<LookupResult>;
}

/** Injection token. The module binds the real or fake implementation. */
export const SMS_PROVIDER = 'SMS_PROVIDER';

/**
 * In-memory provider for tests and local development.
 *
 * Records every send so a test can assert on what would have gone out, and enforces
 * the same GSM-7 rule the real one does — a fake that accepts messages the real
 * provider would bill differently teaches the wrong thing.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly sent: Array<SendSmsParams & { providerMessageSid: string; segments: number }> = [];

  private counter = 0;

  /** Queue a failure for the next send. Used to exercise retry and suppression paths. */
  private nextFailure: PermanentSendError | Error | null = null;

  /** Line types by number, so a test can simulate a landline without a real Lookup. */
  private readonly lineTypes = new Map<string, LookupLineType>();

  failNextSendWith(error: PermanentSendError | Error): void {
    this.nextFailure = error;
  }

  setLineType(phoneE164: string, lineType: LookupLineType): void {
    this.lineTypes.set(phoneE164, lineType);
  }

  reset(): void {
    this.sent.length = 0;
    this.nextFailure = null;
    this.lineTypes.clear();
    this.counter = 0;
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      throw failure;
    }

    // The same assertion the real provider applies. Catching a UCS-2 template in a
    // unit test is the entire point of having the seam.
    const info = assertSendable(params.body, `send to ${params.to}`);

    this.counter += 1;
    const providerMessageSid = `SM${String(this.counter).padStart(32, '0')}`;
    this.sent.push({ ...params, providerMessageSid, segments: info.segments });

    return { providerMessageSid, status: 'queued', segments: info.segments };
  }

  async lookup(phoneE164: string): Promise<LookupResult> {
    const lineType = this.lineTypes.get(phoneE164) ?? 'mobile';
    return { valid: lineType !== 'unknown', lineType };
  }

  /** Convenience for assertions. */
  get lastSent(): (SendSmsParams & { segments: number }) | undefined {
    return this.sent.at(-1);
  }

  sentTo(phoneE164: string): SendSmsParams[] {
    return this.sent.filter((s) => s.to === phoneE164);
  }
}
