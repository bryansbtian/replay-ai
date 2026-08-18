import type { CapabilityStep } from '../artifacts/index.js';
import type { SurfaceTimeouts } from '../surfaces/index.js';

/**
 * How long a step gets, and how that limit is enforced.
 *
 * The budget hierarchy is the one the earlier phases already established, with no third
 * set of numbers invented here:
 *
 * ```text
 * step.execution.timeoutMs   the artifact says this step is different
 *   -> replay override       the caller slows the whole run down, or speeds it up
 *   -> surface timeouts      the defaults every other wait already uses
 * ```
 *
 * The budget is handed to the surface, so a failure is the surface's own specific error.
 * It is *also* enforced from the outside, so a surface that ignores its budget, or one
 * that is wedged, still cannot make a replay hang. The outer bound fires a moment later
 * than the inner one, so the specific error is what a caller normally sees.
 */

const OUTER_BOUND_GRACE_MS = 1_000;

/** Raised by `withDeadline` when a surface call outlived its whole budget. */
export class DeadlineExceededError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Operation did not settle within ${timeoutMs}ms`);
    this.name = 'DeadlineExceededError';
    this.timeoutMs = timeoutMs;
  }
}

export interface BudgetOptions {
  readonly timeouts: SurfaceTimeouts;
  /** Applies to every step that does not declare its own budget. */
  readonly stepTimeoutMs?: number;
}

/** The default budget for a step type, derived from the surface's own waits. */
function defaultBudgetMs(step: CapabilityStep, timeouts: SurfaceTimeouts): number {
  if (step.type === 'navigate') {
    return timeouts.navigationMs;
  }
  if (step.type === 'wait' || step.type === 'checkpoint') {
    return timeouts.locatorMs;
  }
  // An acting step pays for finding the control and then for the interaction.
  return timeouts.locatorMs + timeouts.actionMs;
}

export function stepBudgetMs(step: CapabilityStep, options: BudgetOptions): number {
  const declared = step.execution?.timeoutMs;
  if (declared !== undefined) {
    return declared;
  }
  if (options.stepTimeoutMs !== undefined) {
    return options.stepTimeoutMs;
  }
  return defaultBudgetMs(step, options.timeouts);
}

/**
 * Resolves with the operation, or rejects with `DeadlineExceededError` once the budget
 * and its grace have passed.
 *
 * The timer is always cleared, so a finished replay leaves nothing holding the event
 * loop open.
 */
export async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  const bound = timeoutMs + OUTER_BOUND_GRACE_MS;
  let timer: NodeJS.Timeout | undefined;

  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceededError(timeoutMs));
    }, bound);
  });

  try {
    return await Promise.race([operation(), guard]);
  } finally {
    clearTimeout(timer);
  }
}
