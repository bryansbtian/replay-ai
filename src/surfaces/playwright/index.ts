/**
 * The Playwright adapter. Only composition roots should import from here; workflow code
 * depends on `ComputerSurface` instead.
 */
export {
  LocatorResolver,
  type LocatorResolverOptions,
  type ResolvedTarget,
} from './LocatorResolver.js';
export { PlaywrightSurface, type PlaywrightSurfaceOptions } from './PlaywrightSurface.js';
export {
  launchPlaywrightSession,
  type PlaywrightSession,
  type PlaywrightSessionOptions,
} from './session.js';
