import { config } from 'dotenv';
import { z } from 'zod';

// One .env at the repo root, shared by api and web. Local first so an app-level
// file can override during debugging.
config({ path: ['.env', '../../.env'], quiet: true });

// Booleans from the environment are strings. z.coerce.boolean() would treat the
// string "false" as true — any non-empty string is truthy — which is exactly the
// bug you do not want on SENDING_ENABLED.
const envBool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  API_PORT: z.coerce.number().int().positive().default(3001),

  // Must be the exact URL Twilio calls. Signature validation rebuilds the signed
  // string from it, so a mismatch fails every webhook with no useful error
  // (.claude/skills/twilio/SKILL.md §2).
  PUBLIC_API_URL: z.url(),
  PUBLIC_WEB_URL: z.url(),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_COOKIE_DOMAIN: z.string().min(1),

  // Optional until the Twilio account is provisioned (docs/twilio-setup.md), so the
  // app boots before telephony exists. The telephony module validates their presence
  // at the point of use rather than blocking startup.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  TWILIO_VOICE_NUMBER: z.string().optional(),
  TWILIO_SMS_NUMBER: z.string().optional(),

  // Cost circuit breakers (.claude/skills/queues-redis/SKILL.md §9). Defaults are
  // deliberately conservative — a runaway loop is more expensive than a missed send.
  MAX_SMS_PER_BUSINESS_PER_DAY: z.coerce.number().int().positive().default(200),
  MAX_SMS_PER_NUMBER_PER_DAY: z.coerce.number().int().positive().default(1),
  SENDING_ENABLED: envBool('true'),

  // Which model provider extracts fields from customer replies. Explicit rather
  // than inferred from whichever key happens to be present: with two real providers
  // that inference is ambiguous the moment both keys are set, and "it picked the
  // other one" is not a failure anybody diagnoses quickly. The selected provider's
  // key is then required — see conversations/llm-provider.factory.ts.
  LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail at boot, loudly, with every problem at once — not one crash per deploy.
  // A missing variable must never degrade into blank pages or silent no-ops.
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;
