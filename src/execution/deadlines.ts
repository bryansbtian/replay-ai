/**
 * The outer bound on any operation a run performs.
 *
 * It lives here rather than inside replay because two callers now need the same
 * guarantee. Replay bounds a stored step; discovery bounds a model call and a
 * model-proposed action. Both are protecting against the same thing: a collaborator
 * that accepts a budget and then never settles.
 *
 * This is not a competitor to the surface's own timeouts. The surface is still asked to
 * fail on time, and its failure is the specific one ("the summary never appeared"). This
 * is what stops a wedged collaborator from making a run hang forever, which a surface
 * that is itself stuck cannot do.
 */

/**
 * The outer bound sits half again above the budget, and never less than a second above
 * it.
 *
 * A target with several locator strategies pays a little overhead per strategy on top of
 * the budget it divides between them, so a bound that only just cleared the budget would
 * turn a specific surface failure into a generic "no response", which is a worse answer
 * to the same question.
 */
const OUTER_BOUND_FACTOR = 1.5;
const OUTER_BOUND_GRACE_MS = 1_000;

/** Raised by `withDeadline` when an operation outlived its whole budget. */
export class DeadlineExceededError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Operation did not settle within ${timeoutMs}ms`);
    this.name = 'DeadlineExceededError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Resolves with the operation, or rejects with `DeadlineExceededError` once the budget
 * and its grace have passed.
 *
 * The timer is always cleared, so a finished run leaves nothing holding the event loop
 * open.
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
