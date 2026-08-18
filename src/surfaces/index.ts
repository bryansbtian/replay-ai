/**
 * The surface-neutral half of this module: everything a caller needs to describe a
 * control, act on it, and interpret the outcome. Importing from here can never pull a
 * browser library into the caller, which is the point of the boundary. Concrete
 * implementations are imported from their own directory, for example
 * `./playwright/index.js`.
 */
export type { ComputerSurface } from './ComputerSurface.js';
export {
  ActionFailedError,
  AmbiguousTargetError,
  ExtractionFailedError,
  InvalidTargetError,
  NavigationFailedError,
  SurfaceUnavailableError,
  TargetNotFoundError,
} from './errors.js';
export { createTarget, DEFAULT_STRATEGY_ORDER, type CreateTargetOptions } from './target.js';
export { DEFAULT_SURFACE_TIMEOUTS, type SurfaceTimeouts } from './timeouts.js';
export type * from './types.js';
