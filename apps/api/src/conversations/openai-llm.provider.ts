import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  buildUserMessage,
  EXTRACTION_EFFORT,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_SYSTEM_PROMPT,
  finaliseExtraction,
  LlmUnavailableError,
  type ExtractionRequest,
  type LlmExtractionResult,
  type LlmProvider,
} from './llm.provider';

/**
 * The OpenAI implementation of `LlmProvider`.
 *
 * Sibling to `anthropic-llm.provider.ts`, and deliberately the *only* place in the
 * codebase that imports the OpenAI SDK. Two implementations of one interface is what
 * makes the choice reversible: switching provider is a factory change, not a
 * rewrite, and running both against the same conversations is how you find out which
 * one actually extracts better on Australian suburb names and "2 bed 2 bath".
 *
 * Everything shared lives in `llm.provider.ts` — prompt, output schema, token
 * ceiling, effort, and the `finaliseExtraction` choke point. What is here is only
 * what is true of this API and not the other one.
 */

/**
 * The model. Per-provider, unlike the other constants — model names do not transfer.
 *
 * `gpt-5.6` is the alias used throughout the current API documentation. The SDK's
 * own union additionally lists `gpt-5.6-sol`, `-terra` and `-luna` if a specific
 * variant ever needs pinning for reproducibility.
 */
export const OPENAI_EXTRACTION_MODEL = 'gpt-5.6';

/** Same reasoning as the Anthropic adapter: the caller is waiting on this. */
const REQUEST_TIMEOUT_MS = 25_000;

/** One retry here, the rest at the queue. Two retrying layers multiply, not add. */
const SDK_MAX_RETRIES = 1;

/**
 * Translate the shared schema into OpenAI's strict-mode dialect.
 *
 * The two providers disagree on exactly one point, and it is the kind of
 * disagreement that costs an afternoon if you meet it as a 400 at runtime:
 *
 *   Anthropic  a nullable enum lists `null` among its values, because a value must
 *              satisfy both `type` and `enum`.
 *   OpenAI     strict mode wants `"type": ["string", "null"]` with `null` **absent**
 *              from `enum` — the documented form for an optional enum.
 *
 * So the shared schema keeps the stricter, more conventional JSON Schema form and
 * this function adapts it. That is what an adapter is for: one canonical contract,
 * translated at each boundary, rather than a lowest-common-denominator schema that
 * is wrong for both.
 *
 * Pure and exported so the translation is testable without a network or a key.
 */
export function toOpenAiSchema(schema: unknown): Record<string, unknown> {
  if (Array.isArray(schema)) {
    return schema.map(toOpenAiSchema) as unknown as Record<string, unknown>;
  }
  if (typeof schema !== 'object' || schema === null) {
    return schema as Record<string, unknown>;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'enum' && Array.isArray(value)) {
      // Nullability is already carried by `type`; the null in the enum is the part
      // OpenAI rejects.
      out[key] = value.filter((v) => v !== null);
      continue;
    }
    out[key] = typeof value === 'object' && value !== null ? toOpenAiSchema(value) : value;
  }
  return out;
}

const OPENAI_JSON_SCHEMA = toOpenAiSchema(EXTRACTION_JSON_SCHEMA);

export class OpenAiLlmProvider implements LlmProvider {
  private readonly logger = new Logger(OpenAiLlmProvider.name);

  private readonly client: OpenAI;

  /**
   * The key is read from `process.env` rather than the validated `env` schema
   * because `config/env.ts` has no `OPENAI_API_KEY` field yet — that one-line
   * addition belongs with the factory that chooses between providers, and adding it
   * from here would be a second file in this step. **Flagged rather than hidden:**
   * this is the only place in the codebase that reads `process.env` directly, and it
   * goes away in the next step.
   */
  constructor(apiKey: string | undefined = process.env.OPENAI_API_KEY) {
    if (!apiKey) {
      throw new Error(
        'OpenAiLlmProvider requires OPENAI_API_KEY. The factory should have selected ' +
          'a different provider.',
      );
    }
    this.client = new OpenAI({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: SDK_MAX_RETRIES,
    });
  }

  async extractFields(request: ExtractionRequest): Promise<LlmExtractionResult> {
    const startedAt = Date.now();

    let response;
    try {
      response = await this.client.responses.create({
        model: OPENAI_EXTRACTION_MODEL,

        // `instructions` is this API's dedicated system channel. Keeping the prompt
        // here rather than as a leading input message is also what makes it eligible
        // for automatic prompt caching, which is prefix-based on this provider too.
        instructions: EXTRACTION_SYSTEM_PROMPT,

        input: [{ role: 'user', content: buildUserMessage(request) }],

        reasoning: { effort: EXTRACTION_EFFORT },
        max_output_tokens: EXTRACTION_MAX_TOKENS,

        text: {
          format: {
            type: 'json_schema',
            name: 'enquiry_fields',
            strict: true,
            schema: OPENAI_JSON_SCHEMA,
          },
        },
      });
    } catch (cause) {
      throw this.classify(cause);
    }

    const latencyMs = Date.now() - startedAt;
    const meta = {
      model: response.model,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
      latencyMs,
    };

    // Same posture as the Anthropic adapter: a refusal is a handled outcome, not an
    // error. The conversation continues with nothing extracted rather than stalling.
    const refusal = this.findRefusal(response.output);
    if (refusal !== undefined) {
      this.logger.warn(`Model refused to answer: ${refusal}. Continuing with an empty extraction.`);
      return finaliseExtraction({}, meta);
    }

    if (response.status === 'incomplete') {
      // Reasoning and output share `max_output_tokens` here exactly as thinking and
      // response share `max_tokens` on the other provider — and the failure looks
      // identical: truncated JSON that would otherwise be reported as a parse error.
      this.logger.error(
        `Response incomplete (${response.incomplete_details?.reason ?? 'unknown'}) - ` +
          `raise EXTRACTION_MAX_TOKENS (currently ${EXTRACTION_MAX_TOKENS}).`,
      );
      return finaliseExtraction({}, meta);
    }

    return finaliseExtraction(this.readJson(response.output_text), meta);
  }

  /** A refusal arrives as a content part inside an output message, not a status. */
  private findRefusal(output: OpenAI.Responses.ResponseOutputItem[]): string | undefined {
    for (const item of output) {
      if (item.type !== 'message') continue;
      for (const part of item.content) {
        if (part.type === 'refusal') return part.refusal;
      }
    }
    return undefined;
  }

  /**
   * As in the Anthropic adapter: strict mode should guarantee this parses, and
   * "should guarantee" is not a reason to let an exception escape into a job
   * processor. A failure returns nothing extractable and is handled downstream like
   * any other malformed response.
   */
  private readJson(text: string): unknown {
    if (!text) {
      this.logger.error('Response contained no output text.');
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      this.logger.error(`Response was not valid JSON despite strict mode: ${text.slice(0, 200)}`);
      return {};
    }
  }

  /**
   * Branch on HTTP status, not on SDK error class names — same reasoning as the
   * Anthropic adapter, and it keeps the two classifiers directly comparable.
   *
   * A 400 here most likely means the schema was rejected: this provider's strict
   * mode accepts a narrower subset of JSON Schema than Anthropic's, which is exactly
   * what `toOpenAiSchema` exists to bridge. It is logged as non-retryable so it
   * surfaces on the first call rather than after five silent retries.
   */
  private classify(cause: unknown): LlmUnavailableError {
    if (cause instanceof OpenAI.APIError) {
      const status = cause.status ?? 0;
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      const error = new LlmUnavailableError(
        `OpenAI API error ${status || '(no response)'}: ${cause.message}`,
        retryable,
      );
      if (!retryable) {
        this.logger.error(
          `Non-retryable API error, every extraction will fail: ${error.message}. ` +
            'If this is a 400 about the response format, the schema needs another ' +
            'strict-mode adjustment in toOpenAiSchema.',
        );
      }
      return error;
    }

    return new LlmUnavailableError(
      `Unexpected failure calling the model: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
