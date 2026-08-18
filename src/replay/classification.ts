import { ReplayAiError } from '../errors.js';
import type { PolicyDenialCode } from '../policy/index.js';
import {
  ActionFailedError,
  AmbiguousTargetError,
  ExtractionFailedError,
  InvalidTargetError,
  NavigationFailedError,
  SurfaceUnavailableError,
  TargetNotFoundError,
} from '../surfaces/index.js';

import { DeadlineExceededError } from './deadlines.js';
import type { EngineFailureCode } from './ReplayResult.js';

/**
 * The one place a surface failure becomes a replay classification.
 *
 * The translation happens in two hops, and each hop makes the failure more domain
 * specific and less about the machinery underneath:
 *
 * ```text
 * Playwright TimeoutError  ->  TargetNotFoundError  ->  REPLAY_TARGET_NOT_FOUND
 *      (surface adapter)          (surface domain)          (replay result)
 * ```
 *
 * The first hop already existed: `PlaywrightSurface` catches browser exceptions, keeps
 * the first line of the message, and throws a typed surface error with the original as
 * its `cause`. Replay therefore never sees a Playwright type, and this module never
 * mentions one. The second hop is here, in one function, so that no `instanceof` check
 * for a surface error appears anywhere else in the engine.
 *
 * The mapping is by type, never by matching the text of a message. Message wording is
 * for people and is free to change; a code is a contract.
 */

/** A surface failure, expressed the way a result reports it. */
export interface ClassifiedFailure {
  readonly code: EngineFailureCode;
  /** A rendered one-line summary of the origin. Never the original exception. */
  readonly cause: string;
  /** The part of the failure a caller can read as a sentence. */
  readonly detail: string;
}

/**
 * Codes for which a declared recovery may be attempted.
 *
 * A short list on purpose. These are the failures that a recognizable interstitial can
 * actually cause: a state that did not arrive, a control that a dialog is covering, or a
 * click that did not land. A missing output, an unresolved parameter, or a surface that
 * has gone away are none of those, and pretending a recovery might help would only add a
 * bounded delay before the same failure.
 */
const RECOVERY_ELIGIBLE_CODES: ReadonlySet<EngineFailureCode> = new Set([
  'REPLAY_CHECKPOINT_FAILED',
  'REPLAY_WAIT_TIMEOUT',
  'REPLAY_TARGET_NOT_FOUND',
  'REPLAY_AMBIGUOUS_TARGET',
  'REPLAY_ACTION_FAILED',
]);

/**
 * Accepts a policy denial as well as an engine code, and answers `false` for every one
 * of them. A guardrail that could be cleared by dismissing a dialog and trying again
 * would not be a guardrail.
 */
export function isRecoveryEligible(code: EngineFailureCode | PolicyDenialCode): boolean {
  return RECOVERY_ELIGIBLE_CODES.has(code as EngineFailureCode);
}

/** The first line only: a browser call log belongs in a debugger, not in a result. */
function firstLine(message: string): string {
  return message.split('\n')[0] ?? '';
}

/**
 * Renders where a failure came from, without carrying the original error outwards.
 *
 * The stack is deliberately absent. A caller receiving a result should be able to log it
 * whole, and a serialized stack trace is both noise and a way for an internal path to
 * end up somewhere it was never reviewed for.
 */
export function describeCause(error: unknown): string {
  if (error instanceof ReplayAiError) {
    return `${error.code}: ${firstLine(error.message)}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${firstLine(error.message)}`;
  }
  return 'Unknown Failure';
}

/**
 * Classifies anything thrown while a step was running.
 *
 * Every branch here is a surface error type or the engine's own deadline. The final
 * branch is the only one that reaches `REPLAY_UNEXPECTED_STATE`, which exists for
 * genuinely unclassifiable failures and is not a bucket for things that were never
 * mapped: adding a surface error type without adding it here would land in it, and the
 * classification suite asserts every surface error maps to something specific.
 */
export function classifyThrown(error: unknown): ClassifiedFailure {
  const cause = describeCause(error);

  if (error instanceof DeadlineExceededError) {
    return { code: 'REPLAY_STEP_TIMEOUT', cause, detail: firstLine(error.message) };
  }
  if (error instanceof TargetNotFoundError) {
    return { code: 'REPLAY_TARGET_NOT_FOUND', cause, detail: firstLine(error.message) };
  }
  if (error instanceof AmbiguousTargetError) {
    return { code: 'REPLAY_AMBIGUOUS_TARGET', cause, detail: firstLine(error.message) };
  }
  if (error instanceof InvalidTargetError) {
    return { code: 'REPLAY_TARGET_INVALID', cause, detail: firstLine(error.message) };
  }
  if (error instanceof NavigationFailedError) {
    return { code: 'REPLAY_NAVIGATION_FAILED', cause, detail: firstLine(error.message) };
  }
  if (error instanceof ExtractionFailedError) {
    return { code: 'REPLAY_OUTPUT_EXTRACTION_FAILED', cause, detail: firstLine(error.message) };
  }
  if (error instanceof ActionFailedError) {
    return { code: 'REPLAY_ACTION_FAILED', cause, detail: firstLine(error.message) };
  }
  if (error instanceof SurfaceUnavailableError) {
    return { code: 'REPLAY_SURFACE_UNAVAILABLE', cause, detail: firstLine(error.message) };
  }
  return { code: 'REPLAY_UNEXPECTED_STATE', cause, detail: 'the failure could not be classified' };
}
