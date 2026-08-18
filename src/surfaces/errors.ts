import { ReplayAiError } from '../errors.js';

import type { StrategyAttempt } from './types.js';

/**
 * Surface-level failures.
 *
 * Flat on purpose: each class extends the shared base directly and carries the context
 * needed to debug the failure without re-reading the code. The full execution taxonomy
 * (retryable vs terminal, escalation triggers) belongs to a later phase and is not
 * anticipated here.
 */

/** Renders resolution attempts compactly for an error message. */
function describeAttempts(attempts: readonly StrategyAttempt[]): string {
  if (attempts.length === 0) {
    return 'no strategies were attempted';
  }
  const parts = attempts.map((attempt) => {
    return `${attempt.kind}=${attempt.outcome}(${attempt.matchCount})`;
  });
  return parts.join(', ');
}

/** A target that cannot be resolved by construction, such as one with no strategies. */
export class InvalidTargetError extends ReplayAiError {
  readonly targetDescription: string;

  constructor(targetDescription: string, reason: string) {
    super(`Target "${targetDescription}" is invalid: ${reason}`, 'SURFACE_TARGET_INVALID');
    this.targetDescription = targetDescription;
  }
}

/** No strategy on the target matched anything. */
export class TargetNotFoundError extends ReplayAiError {
  readonly targetDescription: string;
  readonly attempts: readonly StrategyAttempt[];

  constructor(targetDescription: string, attempts: readonly StrategyAttempt[]) {
    super(
      `Could not resolve target "${targetDescription}". Attempts: ${describeAttempts(attempts)}.`,
      'SURFACE_TARGET_NOT_FOUND',
    );
    this.targetDescription = targetDescription;
    this.attempts = attempts;
  }
}

/**
 * At least one strategy matched several elements and no strategy matched exactly one.
 * Raised instead of acting, because picking the first match is how automation silently
 * clicks the wrong button.
 */
export class AmbiguousTargetError extends ReplayAiError {
  readonly targetDescription: string;
  readonly attempts: readonly StrategyAttempt[];

  constructor(targetDescription: string, attempts: readonly StrategyAttempt[]) {
    super(
      `Target "${targetDescription}" is ambiguous; no strategy matched exactly one element. Attempts: ${describeAttempts(attempts)}.`,
      'SURFACE_TARGET_AMBIGUOUS',
    );
    this.targetDescription = targetDescription;
    this.attempts = attempts;
  }
}

export class NavigationFailedError extends ReplayAiError {
  readonly url: string;

  constructor(url: string, reason: string, options?: ErrorOptions) {
    super(`Navigation to ${url} failed: ${reason}`, 'SURFACE_NAVIGATION_FAILED', options);
    this.url = url;
  }
}

/** A target resolved but the interaction did not complete. */
export class ActionFailedError extends ReplayAiError {
  readonly action: string;
  readonly targetDescription: string;

  constructor(action: string, targetDescription: string, reason: string, options?: ErrorOptions) {
    super(
      `Action "${action}" on target "${targetDescription}" failed: ${reason}`,
      'SURFACE_ACTION_FAILED',
      options,
    );
    this.action = action;
    this.targetDescription = targetDescription;
  }
}

/** A target resolved but the requested content could not be read from it. */
export class ExtractionFailedError extends ReplayAiError {
  readonly targetDescription: string;

  constructor(targetDescription: string, reason: string, options?: ErrorOptions) {
    super(
      `Extraction from target "${targetDescription}" failed: ${reason}`,
      'SURFACE_EXTRACTION_FAILED',
      options,
    );
    this.targetDescription = targetDescription;
  }
}

/** The surface itself is gone: the session was closed or the browser crashed. */
export class SurfaceUnavailableError extends ReplayAiError {
  constructor(reason: string, options?: ErrorOptions) {
    super(`Surface is unavailable: ${reason}`, 'SURFACE_UNAVAILABLE', options);
  }
}
