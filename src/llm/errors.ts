import { ReplayAiError } from '../errors.js';

/**
 * Provider failures, in this system's own vocabulary.
 *
 * Discovery never sees an SDK exception. A rate limit, an expired key, and a network
 * that dropped are three different operational problems, and each one is answered by a
 * different person doing a different thing; a caller that had to read an SDK class name
 * to tell them apart would be coupled to whichever provider is configured today.
 *
 * The original exception is preserved as `cause` for a debugger, and never rendered into
 * a message or a record: a provider error can quote the request it failed on, and a
 * request carries a header.
 */

/** Why a model call did not produce a usable answer. */
export const MODEL_FAILURE_CODES = [
  /** The credential was missing, malformed, or refused. */
  'MODEL_AUTHENTICATION_FAILED',
  /** The provider asked us to slow down. */
  'MODEL_RATE_LIMITED',
  /** The call did not return within its budget. */
  'MODEL_TIMEOUT',
  /** The provider was unreachable or answered with a server error. */
  'MODEL_UNAVAILABLE',
  /** The provider refused the request itself, such as an unknown model. */
  'MODEL_REQUEST_REJECTED',
  /** The call succeeded and carried no text to work with. */
  'MODEL_RESPONSE_EMPTY',
] as const;

export type ModelFailureCode = (typeof MODEL_FAILURE_CODES)[number];

/**
 * A model call that did not yield an answer.
 *
 * One class with a code rather than a class per failure: every caller branches on the
 * code, nobody catches these individually, and a flat taxonomy is easier to keep honest
 * than a hierarchy.
 */
export class ModelError extends ReplayAiError {
  constructor(code: ModelFailureCode, message: string, options?: ErrorOptions) {
    super(message, code, options);
  }

  /** Narrowed accessor, so a caller can `switch` without casting. */
  get failure(): ModelFailureCode {
    return this.code as ModelFailureCode;
  }
}

/**
 * The sentence a caller sees for each code, shared by every provider.
 *
 * Fixed text rather than the provider's own message. A provider error can quote the
 * request that failed, and a request carries an authorization header, so nothing from
 * the exception reaches a message. The original stays on `cause`.
 *
 * It lives beside the codes rather than inside one client so that a second provider
 * cannot describe the same failure differently, which would make the two indistinguishable
 * to somebody reading a log.
 */
export const MODEL_FAILURE_MESSAGES: Readonly<Record<ModelFailureCode, string>> = {
  MODEL_AUTHENTICATION_FAILED: 'The model provider refused the configured credential.',
  MODEL_RATE_LIMITED: 'The model provider is rate limiting this deployment.',
  MODEL_TIMEOUT: 'The model did not answer within the allotted time.',
  MODEL_UNAVAILABLE: 'The model provider could not be reached.',
  MODEL_REQUEST_REJECTED: 'The model provider rejected the request.',
  MODEL_RESPONSE_EMPTY: 'The model returned no text to act on.',
};
