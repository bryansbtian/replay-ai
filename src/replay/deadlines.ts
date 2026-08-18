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
 * that is wedged, still cannot make a replay hang.
 */

/**
 * The outer bound sits half again above the budget, and never less than a second above
 * it.
 *
 * It is a guard against a wedged surface, not a competitor to the surface's own timeout.
 * A target with several locator strategies pays a little overhead per strategy on top of
 * the budget it divides between them, so a bound that only just cleared the budget would
 * turn a surface reporting "the summary never appeared" into the engine reporting "no
 * response", which is a worse answer to the same question.
 */
const OUTER_BOUND_FACTOR = 1.5;
const OUTER_BOUND_GRACE_MS = 1_000;

/**
 * A classification probe gets a quarter of the locator budget.
 *
 * Classification runs after a step has already failed, which means the page has finished
 * doing whatever it was going to do. The question is "what is on screen now", not "wait
 * for this to appear", and the full locator budget is the answer to the second question.
 * Charging it for the first would make a run that meets several declared states spend
 * seconds deciding what to call the failure it already has.
 */
const PROBE_BUDGET_DIVISOR = 4;

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

/**
 * Budget for one probe of a settled page: recognizing a declared state, or a declared
 * recoverable condition.
 *
 * Derived from the surface budget rather than fixed, so slowing the whole surface down
 * for a sluggish application slows these down too. The classification pass as a whole is
 * bounded by this multiplied by the number of states the artifact declares.
 */
export function probeBudgetMs(timeouts: SurfaceTimeouts): number {
  return Math.max(1, Math.floor(timeouts.locatorMs / PROBE_BUDGET_DIVISOR));
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
  const bound = Math.max(timeoutMs * OUTER_BOUND_FACTOR, timeoutMs + OUTER_BOUND_GRACE_MS);
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
