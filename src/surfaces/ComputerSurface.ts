import type {
  ActionResult,
  ExtractionOptions,
  ExtractionResult,
  Observation,
  ScreenshotResult,
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
 * caller cannot ignore one by accident.
 */
export interface ComputerSurface {
  /** Moves the surface to a location. Throws `NavigationFailedError` on failure. */
  navigate(url: string): Promise<ActionResult>;

  /** Returns a bounded snapshot of the current state. */
  observe(): Promise<Observation>;

  /** Resolves `target` and activates it. */
  click(target: Target): Promise<ActionResult>;

  /**
   * Resolves `target` and sets its value, replacing whatever was there.
   *
   * Named `fill` rather than `type` because replacement, not keystroke simulation, is
   * the behaviour a replayed workflow needs to be deterministic.
   */
  fill(target: Target, value: string): Promise<ActionResult>;

  /** Resolves `target` and reads content from it. Defaults to visible text. */
  extract(target: Target, options?: ExtractionOptions): Promise<ExtractionResult>;

  /** Captures the whole surface for evidence and debugging. */
  screenshot(): Promise<ScreenshotResult>;
}
