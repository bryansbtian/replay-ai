/**
 * The provider-independent model boundary.
 *
 * One method, text in and text out. It is deliberately not an "agent" interface and
 * deliberately knows nothing about goals, observations, decisions, or policy: everything
 * that gives a request meaning belongs to discovery, and everything that makes a
 * response trustworthy is validation that must happen above this line whatever the
 * provider was.
 *
 * Keeping it this small is what makes the isolation real. A second provider implements
 * two shapes and one method; it cannot bring a vendor concept with it, because there is
 * nowhere in the contract to put one.
 */

export interface ModelRequest {
  /** Stable instructions. Identical on every call in a run, which is what makes it cacheable. */
  readonly system: string;
  /** The one turn that varies: the goal, the recent history, and the current state. */
  readonly instruction: string;
  /** Ceiling on the answer. A structured decision is short, so this stays small. */
  readonly maxOutputTokens?: number;
  /** Ceiling on the call itself, normally what is left of the run's deadline. */
  readonly timeoutMs?: number;
}

/**
 * What a provider answered.
 *
 * The text is the whole of it. There is no field for a raw response body, a transcript,
 * or reasoning, because a type with nowhere to put those is a stronger guarantee than a
 * rule saying not to persist them.
 */
export interface ModelResponse {
  readonly text: string;
  /** The model that actually answered, for evidence and cost attribution. */
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
}

export interface LLMClient {
  /**
   * Sends one request and returns the text of the answer.
   *
   * @throws ModelError with a domain-level code. A provider exception never escapes.
   */
  complete(request: ModelRequest): Promise<ModelResponse>;
}
