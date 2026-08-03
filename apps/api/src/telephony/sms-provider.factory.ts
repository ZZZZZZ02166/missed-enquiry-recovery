import { Logger, type Provider } from '@nestjs/common';
import { env } from '../config/env';
import { FakeSmsProvider, SMS_PROVIDER, type SmsProvider } from './sms.provider';
import { TwilioSmsProvider } from './twilio-sms.provider';

/**
 * Chooses between the real Twilio provider and the in-memory fake.
 *
 * The failure this is designed against: **a production deployment silently running
 * the fake.** Every send would be recorded as successful, every metric would look
 * healthy, and no customer would receive anything. Nobody would notice until a
 * business asked why their leads had stopped — by which time the callers are gone.
 *
 * Three defences, in order of strength:
 *
 *   1. Production *cannot* use the fake. Not a warning — the process refuses to
 *      start. A misconfiguration that silently sends nothing is worse than one that
 *      fails to boot, because the second is noticed immediately.
 *   2. The choice is logged at boot, loudly, naming the implementation.
 *   3. Selection is by explicit credentials, never by a convenience flag that could
 *      be left set.
 */

/**
 * Whether the real provider can be used.
 *
 * Account SID and the sending number are both required: a provider that can
 * authenticate but has no number to send from fails at the first message rather
 * than at startup, which puts the error in the wrong place.
 */
export function twilioIsConfigured(): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_SMS_NUMBER);
}

/**
 * Build the provider for this environment.
 *
 * Exported separately from the Nest provider so it can be reasoned about — and
 * tested — without a DI container.
 */
export function createSmsProvider(logger = new Logger('SmsProvider')): SmsProvider {
  const configured = twilioIsConfigured();

  if (env.NODE_ENV === 'production' && !configured) {
    // Deliberately fatal. In development the fake is a convenience; in production it
    // is a silent outage that reports success.
    throw new Error(
      'Refusing to start: NODE_ENV=production but Twilio is not configured ' +
        '(TWILIO_ACCOUNT_SID and TWILIO_SMS_NUMBER are required). ' +
        'The fake SMS provider records sends without delivering them and must never ' +
        'run in production.',
    );
  }

  if (!configured) {
    // Warn, not log. Someone testing the recovery flow locally needs to know why no
    // text arrived, and this line is the answer.
    logger.warn(
      'Using FakeSmsProvider — messages are recorded in memory and NOT delivered. ' +
        'Set TWILIO_ACCOUNT_SID and TWILIO_SMS_NUMBER to send for real.',
    );
    return new FakeSmsProvider();
  }

  logger.log(`Using TwilioSmsProvider — messages will be DELIVERED from ${env.TWILIO_SMS_NUMBER}`);
  return new TwilioSmsProvider();
}

/**
 * The Nest provider binding.
 *
 * A factory rather than `useClass` because the decision depends on runtime
 * configuration, and because the log line has to happen exactly once, at
 * construction, rather than on every injection.
 */
export const smsProviderFactory: Provider = {
  provide: SMS_PROVIDER,
  useFactory: (): SmsProvider => createSmsProvider(),
};
