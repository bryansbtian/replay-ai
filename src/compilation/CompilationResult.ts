import type { ArtifactIssue, CapabilityArtifact } from '../artifacts/index.js';

/**
 * What compiling a discovery run produced.
 *
 * Two arms, because there are only two things a caller does next: use the capability, or
 * find out why there isn't one. A rejection carries the stage it failed at, because the
 * five stages fail for entirely different reasons and are fixed by different people. A
 * trace that cannot be normalized is a discovery problem; an artifact that will not
 * replay is a workflow problem; a store that will not write is an operations problem.
 */

/**
 * The stages a compilation passes through, in order.
 *
 * Named rather than numbered so a failure says something a person can act on without
 * consulting a table.
 */
export const COMPILATION_STAGES = [
  /** Turning the actions that worked into steps the artifact schema can express. */
  'normalization',
  /** Binding the values the run typed to the inputs the caller named. */
  'parameterization',
  /** The Phase 3 schema and semantic checks, run on the compiler's own output. */
  'validation',
  /** A real replay of the compiled artifact, through the real engine and policy. */
  'verification',
  /** Writing the verified capability to the store. */
  'persistence',
] as const;

export type CompilationStage = (typeof COMPILATION_STAGES)[number];

/** One code per stage. A larger set would be detail nobody branches on. */
export const COMPILATION_FAILURE_CODES = [
  'TRACE_NORMALIZATION_FAILED',
  'PARAMETERIZATION_FAILED',
  'ARTIFACT_VALIDATION_FAILED',
  'VERIFICATION_REPLAY_FAILED',
  'PERSISTENCE_FAILED',
] as const;

export type CompilationFailureCode = (typeof COMPILATION_FAILURE_CODES)[number];

/**
 * The capability was compiled, validated, replayed successfully, and saved.
 *
 * Every one of those had to happen. A capability that exists but was never replayed is
 * exactly the thing this phase is meant to stop shipping.
 */
export interface CompilationSuccess {
  readonly status: 'compiled';
  readonly capability: CapabilityArtifact;
  /** Where it was written. */
  readonly artifactPath: string;
  /** The discovery run this came from, so a reviewer can find its evidence. */
  readonly sourceDiscoveryRunId: string;
  /** The replay that proved it works, so a reviewer can find that evidence too. */
  readonly verificationReplayRunId: string;
  /**
   * Actions from the trace that were not compiled because they did not succeed during
   * discovery.
   *
   * Reported rather than hidden. A model that needed four attempts to find a control
   * produced a workflow with one working step and three mistakes, and only the working
   * one belongs in something meant to be replayed.
   */
  readonly skippedActions: number;
}

export interface CompilationFailure {
  readonly status: 'rejected';
  readonly stage: CompilationStage;
  readonly code: CompilationFailureCode;
  readonly message: string;
  readonly sourceDiscoveryRunId: string;
  /** Present when a compiled artifact was replayed and the replay is what failed. */
  readonly verificationReplayRunId?: string;
  /**
   * The artifact that was produced but not accepted.
   *
   * Returned so a failure can be inspected, and deliberately not written anywhere: an
   * unverified capability in the store is one somebody will eventually invoke.
   */
  readonly capability?: CapabilityArtifact;
  /** Schema or semantic problems, when validation is the stage that failed. */
  readonly issues?: readonly ArtifactIssue[];
}

export type CompilationResult = CompilationSuccess | CompilationFailure;
