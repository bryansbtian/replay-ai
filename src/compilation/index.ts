/**
 * Discovery to capability: the boundary where one run's history becomes a reusable
 * workflow.
 *
 * It depends on the discovery trace models, the artifact contract, the surface target
 * model, and the replay engine it verifies with. It imports no browser library and no
 * model SDK, and it makes no model call: the same trace and the same request always
 * compile to the same artifact, which is what allows a compiled capability to be reviewed
 * rather than merely trusted.
 *
 * Nothing under `replay/` may import from here. Replay is a standalone consumer of
 * validated artifacts and does not know where one came from.
 */
export { ArtifactCompiler, type ArtifactCompilerOptions } from './ArtifactCompiler.js';
export type { CompilationRequest, OutputDescription } from './CompilationRequest.js';
export {
  COMPILATION_FAILURE_CODES,
  COMPILATION_STAGES,
  type CompilationFailure,
  type CompilationFailureCode,
  type CompilationResult,
  type CompilationStage,
  type CompilationSuccess,
} from './CompilationResult.js';
export { compileDraft, CompilationProblem, type CompiledDraft } from './TraceCompiler.js';
export { stepIdFor, UniqueStepIds } from './stepNaming.js';
