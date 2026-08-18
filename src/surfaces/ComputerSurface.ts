import type {
  ActionResult,
  ConditionObservation,
  ExtractionOptions,
  ExtractionResult,
  Observation,
  ScreenshotResult,
  SurfaceCallOptions,
  SurfaceCondition,
  Target,
} from './types.js';

/**
 * The seam between a workflow and the thing it drives.
 *
 * Everything above this line (discovery, replay, execution) works with `Target` and the
 * result types in `./types.js`. Nothing above this line may know that the current
 * implementation happens to be Playwright, which is what allows a second surface to be
 * added later without touching a recorded workflow.
 *
 * Failures throw typed errors from `./errors.js` rather than returning a status, so a
 * caller cannot ignore one by accident. The one exception is `waitFor`: a state that did
 * not arrive is an answer, not a broken surface.
 *
 * Every method takes an optional per-call budget. Without it the surface's own timeouts
 * apply, which is what a caller with nothing special to say should rely on.
 */
export interface ComputerSurface {
  /** Moves the surface to a location. Throws `NavigationFailedError` on failure. */
  navigate(url: string, options?: SurfaceCallOptions): Promise<ActionResult>;

  /** Returns a bounded snapshot of the current state. */
  observe(): Promise<Observation>;

  /** Resolves `target` and activates it. */
  click(target: Target, options?: SurfaceCallOptions): Promise<ActionResult>;

  /**
   * Resolves `target` and sets its value, replacing whatever was there.
   *
   * Named `fill` rather than `type` because replacement, not keystroke simulation, is
   * the behaviour a replayed workflow needs to be deterministic.
   */
  fill(target: Target, value: string, options?: SurfaceCallOptions): Promise<ActionResult>;

  /** Resolves `target` and reads content from it. Defaults to visible text. */
  extract(target: Target, options?: ExtractionOptions): Promise<ExtractionResult>;

  /**
   * Waits until the condition holds or the budget runs out, and reports what it saw.
   *
   * State-based throughout: an implementation waits on the state itself rather than
   * sleeping and re-checking, so a caller never has to own a polling interval.
   *
   * A condition that names a target is satisfied by one or more matches. That is
   * deliberately looser than the exactly-one rule the action methods enforce: asking
   * whether something is on screen is not the same question as deciding which single
   * control to click.
   */
  waitFor(condition: SurfaceCondition, options?: SurfaceCallOptions): Promise<ConditionObservation>;

  /** Captures the whole surface for evidence and debugging. */
  screenshot(): Promise<ScreenshotResult>;
}
