/**
 * Deterministic replay: a saved capability artifact, an invocation, and a surface in;
 * a structured result out.
 *
 * Nothing in this package imports the model layer, the discovery loop, an SDK, or a
 * browser library. That is the point of it: replay is the production path, and a
 * production path that had to ask a model what to do next would be neither predictable
 * nor cheap. The rule is enforced by ESLint and by `tests/architecture.test.ts`.
 *
 * The collaborators the engine composes (`StepExecutor`, `CheckpointEvaluator`, the
 * budget helpers) are deliberately not exported. `ReplayEngine` is the entry point, and
 * a smaller surface is one fewer thing to keep compatible.
 */
export { InvocationInputError, type InvocationIssue } from './errors.js';
export {
  validateInvocationInputs,
  type InvocationInputs,
  type ResolvedInputs,
  type ResolvedInputValue,
} from './InputValidator.js';
export { OutputCollector, type CollectOutcome, type RecordOutcome } from './OutputCollector.js';
export { resolveParameter, type ParameterResolution } from './ParameterResolver.js';
export { ReplayEngine, type ReplayEngineOptions } from './ReplayEngine.js';
export {
  REPLAY_FAILURE_CODES,
  type OutputValue,
  type ReplayBusinessOutcome,
  type ReplayFailure,
  type ReplayFailureCode,
  type ReplayResult,
  type ReplayStepRecord,
  type ReplaySuccess,
} from './ReplayResult.js';
