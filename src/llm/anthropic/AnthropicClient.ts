import Anthropic from '@anthropic-ai/sdk';

import { ModelError, type ModelFailureCode } from '../errors.js';
import type { LLMClient, ModelRequest, ModelResponse } from '../LLMClient.js';

/**
 * The Anthropic implementation of the model boundary, and the only file in the system
 * that imports the SDK.
 *
 * Everything provider-specific stops here: the client construction, the request shape,
 * the content-block walk, and the exception taxonomy. Discovery above it works with
 * `LLMClient`, `ModelRequest`, and `ModelError`, so swapping the provider is a change to
 * this directory and to the composition root that names it.
 *
 * Two decisions are worth stating. The request carries only a system prompt and one user
 * turn, because discovery composes the state it wants the model to see rather than
 * letting a transcript grow without bound. And the response is reduced to its text: the
 * raw message, including any reasoning blocks the model produced, is never returned,
 * logged, or stored, so there is no path by which it could reach evidence.
 */

/** A structured decision is a short JSON object; this is generous for one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

/** Ceiling for one call when the caller names none. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One extra attempt, and only for the failures the SDK already treats as transient
 * (429, 5xx, connection errors).
 *
 * Bounded deliberately. A model that is rate limited is telling the deployment something
 * true, and a client that retries around it turns one slow run into a bill.
 */
const MAX_RETRIES = 1;

export interface AnthropicClientOptions {
  readonly apiKey: string;
  /** Model identifier, from configuration. Never hard-coded by a caller. */
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  /** Injected in tests so the SDK boundary can be exercised without a network. */
  readonly client?: Pick<Anthropic, 'messages'>;
}

/**
 * Maps an SDK exception onto a domain code.
 *
 * By type and status, never by matching message text: wording belongs to the provider
 * and changes without notice, while a code is something this system promises.
 */
function classify(error: unknown): ModelFailureCode {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return 'MODEL_TIMEOUT';
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'MODEL_UNAVAILABLE';
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return 'MODEL_AUTHENTICATION_FAILED';
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'MODEL_AUTHENTICATION_FAILED';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'MODEL_RATE_LIMITED';
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status !== undefined && status >= 500) {
      return 'MODEL_UNAVAILABLE';
    }
    return 'MODEL_REQUEST_REJECTED';
  }
  return 'MODEL_UNAVAILABLE';
}

/**
 * The sentence a caller sees for each code.
 *
 * Fixed text rather than the provider's message. A provider error can quote the request
 * that failed, and a request carries an authorization header, so the safe thing is for
 * nothing from the exception to reach a message. The original stays on `cause`.
 */
const FAILURE_MESSAGES: Readonly<Record<ModelFailureCode, string>> = {
  MODEL_AUTHENTICATION_FAILED: 'The model provider refused the configured credential.',
  MODEL_RATE_LIMITED: 'The model provider is rate limiting this deployment.',
  MODEL_TIMEOUT: 'The model did not answer within the allotted time.',
  MODEL_UNAVAILABLE: 'The model provider could not be reached.',
  MODEL_REQUEST_REJECTED: 'The model provider rejected the request.',
  MODEL_RESPONSE_EMPTY: 'The model returned no text to act on.',
};

export function toModelError(error: unknown): ModelError {
  const code = classify(error);
  return new ModelError(code, FAILURE_MESSAGES[code], { cause: error });
}

export class AnthropicClient implements LLMClient {
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;

  constructor(options: AnthropicClientOptions) {
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        maxRetries: MAX_RETRIES,
        timeout: this.timeoutMs,
      });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens ?? this.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.instruction }],
        },
        { timeout: timeoutMs },
      );
    } catch (error) {
      throw toModelError(error);
    }

    const text = textOf(message);
    if (text === '') {
      throw new ModelError('MODEL_RESPONSE_EMPTY', FAILURE_MESSAGES.MODEL_RESPONSE_EMPTY);
    }

    return {
      text,
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

/**
 * The text blocks, and only the text blocks.
 *
 * Every other block type is dropped rather than rendered, which is how reasoning content
 * stops at this function: it is never read, so it cannot be returned, logged, or written
 * to evidence by anything downstream.
 */
function textOf(message: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
