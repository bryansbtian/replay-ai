/**
 * Every wait a surface performs is bounded by one of these three numbers.
 *
 * Kept in one place so that a caller can slow the whole surface down for a sluggish
 * legacy application, or speed it up in tests, without hunting for constants. There are
 * no fixed sleeps anywhere in the surface: waiting is always state-based with one of
 * these as the ceiling.
 */
export interface SurfaceTimeouts {
  /** Ceiling for a page load. */
  readonly navigationMs: number;
  /** Ceiling for a single locator strategy to resolve. Paid once per strategy tried. */
  readonly locatorMs: number;
  /** Ceiling for an interaction once its target has resolved. */
  readonly actionMs: number;
}

export const DEFAULT_SURFACE_TIMEOUTS: SurfaceTimeouts = {
  navigationMs: 15_000,
  // Deliberately smaller than the others: it is paid once per strategy, so a target
  // with six strategies must still fail in a reasonable time.
  locatorMs: 5_000,
  actionMs: 10_000,
};
