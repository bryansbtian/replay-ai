import type { CapabilityStepType } from '../artifacts/index.js';

/**
 * What a replay hands back.
 *
 * Three outcomes rather than a boolean, because the three are genuinely different
 * things to a caller: the workflow reached the state it was recorded to reach, the
 * business answered in a way the capability already knows about, or the automation
 * could not finish. Only the first carries outputs.
 *
 * Deliberately small. Phase 5 formalizes the wider taxonomy (recoverable versus
 * terminal, escalation triggers) and will extend these types rather than replace them.
 */

/** The value types a capability output can hold, matching the Phase 3 `ValueType` set. */
export type OutputValue = string | number | boolean;

export const REPLAY_FAILURE_CODES = [
  /** The invocation inputs did not match the artifact's declared inputs. */
  'REPLAY_INPUTS_INVALID',
  /** A stored value reference named an input that was not supplied. */
  'REPLAY_PARAMETER_UNRESOLVED',
  /** A surface action did not complete: the control was missing, ambiguous, or inert. */
  'REPLAY_STEP_FAILED',
  /** A `checkpoint` step asserted a state the surface did not show. */
  'REPLAY_CHECKPOINT_FAILED',
  /** A `wait` step's condition never arrived. */
  'REPLAY_WAIT_FAILED',
  /** A step exceeded its budget. */
  'REPLAY_STEP_TIMEOUT',
  /** Every step ran, but the capability's success condition did not hold. */
  'REPLAY_SUCCESS_CONDITION_FAILED',
  /** A declared output was never produced. */
  'REPLAY_OUTPUT_MISSING',
  /** An extracted value could not be read as the declared output type. */
  'REPLAY_OUTPUT_TYPE_MISMATCH',
  /** A step assigned to an output the capability does not declare. */
  'REPLAY_OUTPUT_UNDECLARED',
  /** The surface itself went away mid-run. */
  'REPLAY_SURFACE_UNAVAILABLE',
  /** Anything the engine did not anticipate, reported rather than rethrown raw. */
  'REPLAY_UNEXPECTED',
] as const;

export type ReplayFailureCode = (typeof REPLAY_FAILURE_CODES)[number];

/** One step that ran to completion, in execution order. */
export interface ReplayStepRecord {
  readonly stepId: string;
  readonly stepType: CapabilityStepType;
  /** How many times the step was executed, including the one that succeeded. */
  readonly attempts: number;
  readonly durationMs: number;
}

interface ReplayResultBase {
  /** Identifies this run in logs and, later, in evidence. */
  readonly replayId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly completedSteps: readonly ReplayStepRecord[];
  readonly durationMs: number;
}

export interface ReplaySuccess extends ReplayResultBase {
  readonly status: 'success';
  /** Exactly the outputs the capability declares, typed as it declared them. */
  readonly outputs: Readonly<Record<string, OutputValue>>;
}

/**
 * The business gave a known answer. The automation worked; the workflow did not reach
 * its success state because the application had something else to say.
 */
export interface ReplayBusinessOutcome extends ReplayResultBase {
  readonly status: 'businessOutcome';
  readonly code: string;
  readonly description: string;
  /** Where the outcome was detected. Absent when the success condition detected it. */
  readonly stepId?: string;
}

/**
 * The automation could not finish. Carries enough to answer which capability, which
 * step, which action, what was expected, and what the surface actually showed.
 *
 * Never carries an invocation value, a credential, or a raw surface exception: `cause`
 * is a rendered one-line summary, not the original error object.
 */
export interface ReplayFailure extends ReplayResultBase {
  readonly status: 'failure';
  readonly code: ReplayFailureCode;
  readonly message: string;
  readonly stepId?: string;
  readonly stepType?: CapabilityStepType;
  readonly expected?: string;
  readonly observed?: string;
  readonly attempts?: number;
  readonly cause?: string;
}

export type ReplayResult = ReplaySuccess | ReplayBusinessOutcome | ReplayFailure;
