/**
 * The capability artifact contract: what a discovered workflow is frozen into, and what
 * a later replay executes. Everything here is plain data and a validator for it. There
 * is no model, no browser, and no execution: importing this module can never start
 * anything.
 */
export {
  capabilityArtifactSchema,
  OUTCOME_DISPOSITIONS,
  SCHEMA_VERSION,
  VALUE_TYPES,
  type BusinessOutcomeDefinition,
  type CapabilityArtifact,
  type CapabilityMetadata,
  type InputDefinition,
  type OutcomeDisposition,
  type OutputDefinition,
  type RecoveryAction,
  type RecoveryDefinition,
  type TargetApplication,
  type ValueType,
} from './artifact.js';
export {
  ArtifactValidationError,
  CapabilityNotFoundError,
  InvalidCapabilityIdError,
  type ArtifactIssue,
} from './errors.js';
export { deserializeCapabilityArtifact, serializeCapabilityArtifact } from './serialization.js';
export {
  RISK_LEVELS,
  type CapabilityStep,
  type CapabilityStepType,
  type CapabilityValue,
  type Checkpoint,
  type CheckpointType,
  type ExecutionPolicy,
  type ParameterReference,
  type RiskLevel,
} from './steps.js';
export {
  FileArtifactStore,
  type CapabilitySummary,
  type FileArtifactStoreOptions,
} from './store.js';
export { parseCapabilityArtifact, type ParseArtifactOptions } from './validation.js';
