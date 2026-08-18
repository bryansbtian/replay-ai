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
