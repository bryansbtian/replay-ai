import { MODEL_FAILURE_MESSAGES, ModelError, type ModelFailureCode } from '../errors.js';
import type { LLMClient, ModelRequest, ModelResponse } from '../LLMClient.js';

/**
 * The Ollama implementation of the model boundary, for a model running on the machine
 * that is driving the run.
 *
 * It exists to prove the boundary is real. `LLMClient` was written so that a provider
 * could be replaced without discovery noticing, and the only way to know that is true is
 * to have two. Discovery imports neither this file nor the Anthropic one: it is handed a
 * client by a composition root and cannot tell which it received.
 *
 * There is no SDK. The chat endpoint is one POST returning one JSON object, and a
 * dependency to express that would be a dependency to audit and update for nothing.
 *
 * Two decisions carry the safety properties of this file.
 *
 * `format: 'json'` constrains the runtime to emit syntactically valid JSON. It does not
 * make the answer a valid decision, and nothing here treats it as if it did: the text is
 * returned unparsed, and `parseAgentDecision` above this line is still the only thing
 * that can produce a decision. What it removes is the failure a small local model is most
 * prone to, which is a sentence of preamble in front of the object.
 *
 * A reasoning field is never read. A reasoning model served by this runtime returns its
 * reasoning beside the answer rather than inside it. This client copies out the message
 * content and nothing else, so private reasoning stops here and there is no path by which
 * it could reach a trace, a log, or an evidence file.
 */

/** A structured decision is a short JSON object; this is generous for one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

/**
 * Ceiling for one call when the caller names none.
 *
 * Higher than a hosted client would use, because a local model is bounded by the machine
 * it runs on and a first call also pays for loading weights into memory, which a remote
 * endpoint has already done.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Deterministic sampling.
 *
 * Discovery wants the model's best single next action, not variety. It also makes a run
 * easier to reason about: the same screen twice produces the same proposal, which is
 * exactly the case the repeated-action guard exists to catch.
 */
const TEMPERATURE = 0;

/** The subset of the chat response this client reads. Every other field is ignored. */
interface OllamaChatResponse {
  readonly model?: unknown;
  readonly message?: { readonly content?: unknown };
  readonly prompt_eval_count?: unknown;
  readonly eval_count?: unknown;
}

/** Injected in tests, so the HTTP boundary can be exercised without a server. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OllamaClientOptions {
  /** Where the daemon listens, for example `http://127.0.0.1:11434`. From configuration. */
  readonly baseUrl: string;
  /** Model identifier, from configuration. Never hard-coded by a caller. */
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

/**
 * Maps an HTTP status onto a domain code.
 *
 * A local daemon uses fewer of these than a hosted API, and they are kept anyway: a
 * caller branches on a code that means the same thing whichever provider produced it,
 * which is the entire reason the taxonomy is not per-provider.
 */
function classifyStatus(status: number): ModelFailureCode {
  if (status === 401 || status === 403) {
    return 'MODEL_AUTHENTICATION_FAILED';
  }
  if (status === 404) {
    // A model that was never pulled answers 404. That is a rejected request rather than
    // an outage: nothing will change until somebody pulls it.
    return 'MODEL_REQUEST_REJECTED';
  }
  if (status === 429) {
    return 'MODEL_RATE_LIMITED';
  }
  if (status >= 500) {
    return 'MODEL_UNAVAILABLE';
  }
  return 'MODEL_REQUEST_REJECTED';
}

/**
 * Maps a thrown transport failure onto a domain code.
 *
 * An aborted request is the deadline firing. Anything else means the daemon could not be
 * reached, which for a local provider usually means it is not running.
 */
function classifyThrown(error: unknown): ModelFailureCode {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'MODEL_TIMEOUT';
  }
  return 'MODEL_UNAVAILABLE';
}

function modelError(code: ModelFailureCode, cause?: unknown): ModelError {
  if (cause === undefined) {
    return new ModelError(code, MODEL_FAILURE_MESSAGES[code]);
  }
  return new ModelError(code, MODEL_FAILURE_MESSAGES[code], { cause });
}

/**
 * What the runtime is told the answer must look like.
 *
 * A schema when the caller supplied one, and bare JSON otherwise. This runtime compiles a
 * schema into a decoding grammar, so a constrained answer cannot be structurally wrong,
 * which is the difference between a small local model being usable here and not: without
 * it an 8B model reliably produces plausible JSON with the fields in the wrong places.
 *
 * It constrains shape, never meaning. A grammar cannot stop a model naming a control that
 * is not on screen, so the answer is still parsed and still validated above this line.
 */
function formatFor(request: ModelRequest): unknown {
  if (request.responseSchema !== undefined) {
    return request.responseSchema;
  }
  return 'json';
}

/** Token counts are best-effort from the runtime; a missing one is zero, never a guess. */
function countOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

export class OllamaClient implements LLMClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly fetch: FetchLike;

  constructor(options: OllamaClientOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, '')}/api/chat`;
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetch = options.fetch ?? ((input, init): Promise<Response> => fetch(input, init));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = performance.now();
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;

    const body = {
      model: this.model,
      stream: false,
      format: formatFor(request),
      options: {
        temperature: TEMPERATURE,
        num_predict: request.maxOutputTokens ?? this.maxOutputTokens,
      },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.instruction },
      ],
    };

    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw modelError(classifyThrown(error), error);
    }

    if (!response.ok) {
      // The body is deliberately not read into the error. It is the provider's wording
      // about a request this system composed, and a message is a thing people paste.
      throw modelError(classifyStatus(response.status));
    }

    let payload: OllamaChatResponse;
    try {
      payload = (await response.json()) as OllamaChatResponse;
    } catch (error) {
      throw modelError('MODEL_UNAVAILABLE', error);
    }

    const text = textOf(payload);
    if (text === '') {
      throw modelError('MODEL_RESPONSE_EMPTY');
    }

    return {
      text,
      model: modelOf(payload, this.model),
      inputTokens: countOf(payload.prompt_eval_count),
      outputTokens: countOf(payload.eval_count),
      durationMs: Math.round(performance.now() - started),
    };
  }
}

/** What actually answered, falling back to what was asked for when the runtime is quiet. */
function modelOf(payload: OllamaChatResponse, requested: string): string {
  if (typeof payload.model === 'string' && payload.model !== '') {
    return payload.model;
  }
  return requested;
}

/**
 * The answer, and only the answer.
 *
 * A reasoning field is not named here, which is how reasoning content stops at this
 * function: it is never read, so it cannot be returned, logged, or written to evidence by
 * anything downstream.
 */
function textOf(payload: OllamaChatResponse): string {
  const content = payload.message?.content;
  if (typeof content !== 'string') {
    return '';
  }
  return content.trim();
}
