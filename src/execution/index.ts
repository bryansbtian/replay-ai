/**
 * What discovery and replay both need in order to execute something.
 *
 * Deliberately small. It holds what has two callers today, and nothing that has one:
 * replay still applies a stored step through `ComputerSurface` in its own executor, and
 * discovery applies a model-proposed action in its own, because the two answer to
 * different authorities. The deadline guard is shared because both are bounding the same
 * risk, and two copies of it would be two places for the bound to drift.
 */
export { DeadlineExceededError, withDeadline } from './deadlines.js';
