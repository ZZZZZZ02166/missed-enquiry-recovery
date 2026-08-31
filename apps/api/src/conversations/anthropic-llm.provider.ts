import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  buildUserMessage,
  CATALOGUE_JSON_SCHEMA,
  CATALOGUE_MAX_TOKENS,
  CATALOGUE_SYSTEM_PROMPT,
  EXTRACTION_EFFORT,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_MODEL,
  EXTRACTION_SYSTEM_PROMPT,
  finaliseCatalogue,
  finaliseExtraction,
  LlmUnavailableError,
  type CatalogueExtractionRequest,
  type ExtractionRequest,
  type LlmCatalogueResult,
  type LlmExtractionResult,
  type LlmProvider,
} from './llm.provider';

/**
 * The Claude implementation of `LlmProvider`.
 *
 * Isolated from `llm.provider.ts` for the same reason `twilio-sms.provider.ts` is
 * isolated from `sms.provider.ts`: this file imports an SDK and needs a key, and
 * nothing that a unit test touches should have to.
 *
 * It contains no policy. Model, effort, token ceiling, prompt and schema all arrive
 * as constants from `llm.provider.ts`, and the result leaves through
 * `finaliseExtraction` like every other implementation. What lives here is only the
 * things that are specifically true of this API: how to ask, how to read the answer,
 * and which failures are worth retrying.
 */

/**
 * Bounded so a slow model cannot outlive the promise we made the caller.
 *
 * The voice greeting says a text is coming; the job that sends it is waiting on this
 * call. Twenty-five seconds is already at the edge of acceptable — beyond that,
 * failing and letting the queue retry is better than holding a worker slot.
 */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * One retry inside the SDK, not the default two.
 *
 * BullMQ already retries this job with backoff. Two layers of retry multiply rather
 * than add: three SDK attempts inside five job attempts is fifteen calls against an
 * overloaded API, which is how a transient blip becomes a bill
 * (`.claude/skills/queues-redis/SKILL.md` §4).
 */
const SDK_MAX_RETRIES = 1;

export class AnthropicLlmProvider implements LlmProvider {
  private readonly logger = new Logger(AnthropicLlmProvider.name);

  private readonly client: Anthropic;

  /**
   * The key is supplied by `llm-provider.factory.ts` from the validated `env`
   * schema. No default, for the same reason as the OpenAI adapter: an adapter that
   * falls back to the ambient environment can run with a key the factory did not
   * choose.
   */
  constructor(apiKey: string | undefined) {
    if (!apiKey) {
      // Fail at construction, not at the first customer reply. A provider that
      // builds successfully and then throws mid-conversation puts the error in the
      // wrong place and loses a lead to find it.
      throw new Error(
        'AnthropicLlmProvider requires ANTHROPIC_API_KEY. The factory should have ' +
          'selected the fake instead.',
      );
    }
    this.client = new Anthropic({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: SDK_MAX_RETRIES,
    });
  }

  async extractFields(request: ExtractionRequest): Promise<LlmExtractionResult> {
    const startedAt = Date.now();

    let response;
    try {
      response = await this.client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: EXTRACTION_MAX_TOKENS,

        // An array with `cache_control`, not a bare string. The system prompt is
        // identical on every call for every business, so it is the one part of the
        // request worth caching — and caching is a prefix match, which is why nothing
        // per-request is allowed into it (see `llm.provider.ts`).
        system: [
          {
            type: 'text',
            text: EXTRACTION_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],

        messages: [{ role: 'user', content: buildUserMessage(request) }],

        // Adaptive is the default on this model, but stated explicitly: the default
        // differs by model, and a future change of `EXTRACTION_MODEL` must not
        // silently turn thinking off. Thinking stays on at low effort deliberately —
        // disabling it is the documented cause of stray tags leaking into output.
        thinking: { type: 'adaptive' },

        output_config: {
          effort: EXTRACTION_EFFORT,
          // The schema is `as const` for the parity assertions in the tests; the SDK
          // wants a plain record. The cast is shape-preserving.
          format: {
            type: 'json_schema',
            schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
          },
        },
      });
    } catch (cause) {
      throw this.classify(cause);
    }

    const latencyMs = Date.now() - startedAt;
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const meta = { model: response.model, usage, latencyMs };

    // Checked before `content` is touched. On a refusal the content array can be
    // empty, and indexing it blindly is the documented way to turn a handled outcome
    // into a crash.
    if (response.stop_reason === 'refusal') {
      // Deliberately not an error. A refusal on "2 bed 2 bath in Southbank" would be
      // extraordinary, but if it happens the conversation must continue with no
      // extracted fields — the next question still gets asked, and the owner still
      // gets a lead. Stalling the thread on a safety classifier would lose the job.
      this.logger.warn(
        `Model refused to answer (category=${response.stop_details?.category ?? 'unknown'}). ` +
          'Continuing with an empty extraction.',
      );
      return finaliseExtraction({}, meta);
    }

    if (response.stop_reason === 'max_tokens') {
      // The JSON is truncated mid-object, so parsing it would fail below anyway —
      // this exists to name the cause, because "invalid JSON" would send the next
      // reader looking at the schema instead of the token ceiling.
      this.logger.error(
        `Hit max_tokens (${EXTRACTION_MAX_TOKENS}) before the JSON was complete. ` +
          'Thinking and response share this ceiling - raise EXTRACTION_MAX_TOKENS.',
      );
      return finaliseExtraction({}, meta);
    }

    return finaliseExtraction(this.readJson(response.content), meta);
  }

  /**
   * Read a price list or handbook once, at import.
   *
   * Structurally the same call as `extractFields` with three deliberate differences: a
   * much larger token ceiling because the answer is a whole catalogue rather than eight
   * fields, no prompt caching because every document is different so a cache would only
   * add latency, and no swallowing of failure. A conversation that cannot extract still
   * asks its next question; an import that fails has nothing to show the owner, so it
   * throws and the screen says so.
   */
  async extractCatalogue(request: CatalogueExtractionRequest): Promise<LlmCatalogueResult> {
    const startedAt = Date.now();

    let response;
    try {
      response = await this.client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: CATALOGUE_MAX_TOKENS,
        system: CATALOGUE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: request.text }],
        thinking: { type: 'adaptive' },
        output_config: {
          // Higher than the conversation's `low`. Reading a price list is a
          // once-per-business job with the owner watching, and a misread price is
          // expensive in a way a slower import is not.
          effort: 'medium',
          format: {
            type: 'json_schema',
            schema: CATALOGUE_JSON_SCHEMA as unknown as Record<string, unknown>,
          },
        },
      });
    } catch (cause) {
      throw this.classify(cause);
    }

    const meta = {
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      latencyMs: Date.now() - startedAt,
    };

    if (response.stop_reason === 'refusal') {
      throw new LlmUnavailableError(
        'The model declined to read this document. Try pasting the relevant text instead.',
        false,
      );
    }
    if (response.stop_reason === 'max_tokens') {
      // Unlike the conversation path this cannot be shrugged off: the JSON is truncated,
      // so the owner would see a catalogue that silently stops halfway and approve it.
      throw new LlmUnavailableError(
        `The document produced more than ${CATALOGUE_MAX_TOKENS} tokens of output. ` +
          'Import a shorter section.',
        false,
      );
    }

    return finaliseCatalogue(this.readJson(response.content), meta);
  }

  /**
   * Pull the JSON object out of the response.
   *
   * Structured outputs constrain the text block to the schema, so this should always
   * succeed — but "should always" is exactly the assumption that produces an
   * unhandled exception inside a job processor at 6pm on a Friday. A failure here
   * returns nothing extractable rather than throwing, and `finaliseExtraction`
   * treats it the same as any other malformed response.
   */
  private readJson(content: Anthropic.ContentBlock[]): unknown {
    const text = content.find((block) => block.type === 'text')?.text;
    if (text === undefined) {
      this.logger.error('Response contained no text block.');
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      this.logger.error(
        `Response was not valid JSON despite output_config.format: ${text.slice(0, 200)}`,
      );
      return {};
    }
  }

  /**
   * Decide whether a failure is worth another attempt.
   *
   * Retryability is branched on the HTTP status rather than on SDK error class
   * names: the status is the stable contract, and a class rename would otherwise
   * turn a rate limit into a permanent failure without a compile error to show for
   * it.
   *
   * The split matters because the two get opposite treatment upstream. A 429 or a
   * 529 will succeed shortly; a 401 will not, and retrying it four more times only
   * delays the moment someone reads the log and fixes the key.
   */
  private classify(cause: unknown): LlmUnavailableError {
    if (cause instanceof Anthropic.APIError) {
      const status = cause.status ?? 0;
      // No status means the request never got a response — a connection reset or a
      // timeout. Both are transient by definition.
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      const error = new LlmUnavailableError(
        `Anthropic API error ${status || '(no response)'}: ${cause.message}`,
        retryable,
      );
      if (!retryable) {
        // A 400 here means the request shape is wrong — schema, model name, or a
        // parameter this model does not accept. That is a deploy-time bug wearing a
        // runtime failure's clothes, and it will affect every conversation until
        // someone looks.
        this.logger.error(`Non-retryable API error, every extraction will fail: ${error.message}`);
      }
      return error;
    }

    return new LlmUnavailableError(
      `Unexpected failure calling the model: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
