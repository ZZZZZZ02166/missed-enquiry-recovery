import { Logger, type Provider } from '@nestjs/common';
import { env } from '../config/env';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { FakeLlmProvider, LLM_PROVIDER, type LlmProvider } from './llm.provider';
import { OpenAiLlmProvider } from './openai-llm.provider';

/**
 * Chooses between Claude, OpenAI, and the in-memory fake.
 *
 * Deliberately the same shape as `telephony/sms-provider.factory.ts`, and for the
 * same reason: **a production deployment silently running the fake.** Every
 * extraction would return no fields, every conversation would ask its questions and
 * learn nothing, and every lead would reach the owner empty. Nothing would error.
 * The dashboard would fill with blank leads and it would look like customers had
 * simply stopped answering.
 *
 * Three defences, in order of strength:
 *
 *   1. Production *cannot* use the fake. Not a warning — the process refuses to
 *      start. A misconfiguration that boots and quietly extracts nothing is worse
 *      than one that fails loudly, because the second is noticed in minutes.
 *   2. The choice is logged at boot, naming the implementation and the model.
 *   3. Selection is by explicit configuration plus a present key, never by a
 *      convenience flag that could be left set.
 *
 * There is no way to select the fake. It is what you get when the chosen provider
 * has no key, which is a state you can only reach by accident — and never in
 * production.
 */

/** The key the selected provider needs, or undefined if it has none. */
function keyFor(provider: 'anthropic' | 'openai'): string | undefined {
  return provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
}

/**
 * Build the provider for this environment.
 *
 * Exported separately from the Nest binding so it can be reasoned about — and
 * tested — without a DI container.
 */
export function createLlmProvider(logger = new Logger('LlmProvider')): LlmProvider {
  const choice = env.LLM_PROVIDER;
  const apiKey = keyFor(choice);

  if (!apiKey) {
    const keyName = choice === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';

    if (env.NODE_ENV === 'production') {
      throw new Error(
        `Refusing to start: LLM_PROVIDER=${choice} but ${keyName} is not set. ` +
          'The fake LLM provider extracts no fields from any message, which in ' +
          'production means every lead reaches the owner blank and nothing errors.',
      );
    }

    // Warn, not log. Someone wondering why a conversation never progresses past the
    // first question needs this line to be the answer.
    logger.warn(
      `Using FakeLlmProvider — no fields will be extracted from customer replies. ` +
        `Set ${keyName} to use ${choice} for real.`,
    );
    return new FakeLlmProvider();
  }

  // The key is passed explicitly rather than left to each adapter's default. It
  // keeps configuration in one place and means an adapter cannot quietly pick up a
  // key from somewhere this factory did not choose.
  if (choice === 'openai') {
    logger.log('Using OpenAiLlmProvider — extraction requests will be BILLED');
    return new OpenAiLlmProvider(apiKey);
  }

  logger.log('Using AnthropicLlmProvider — extraction requests will be BILLED');
  return new AnthropicLlmProvider(apiKey);
}

/**
 * The Nest provider binding.
 *
 * A factory rather than `useClass` because the decision depends on runtime
 * configuration, and because the log line has to happen exactly once, at
 * construction, rather than on every injection.
 */
export const llmProviderFactory: Provider = {
  provide: LLM_PROVIDER,
  useFactory: (): LlmProvider => createLlmProvider(),
};
