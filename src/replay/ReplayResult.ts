import type { CapabilityStepType } from '../artifacts/index.js';

/**
 * What a replay hands back.
 *
 * The assignment asks a replay to separate four things: a normal success, a business
 * outcome, a recoverable runtime condition, and a hard failure. Three of them are ways a
 * run can end. The fourth is not:
 *
 * ```text
 * success           a terminal status
 * businessOutcome   a terminal status
 * hard failure      a terminal status
 * recoverable       something that happened during the run
 * ```
 *
 * A recognized condition that was cleared ends as a success, and a recognized condition
 * whose bounded recovery ran out ends as a failure. Reporting "recoverable" after the
 * engine has already exhausted its recovery would tell a caller to do something the
 * engine has already tried, so the condition is reported in two places instead: every
 * result carries the `recoveries` it performed, and a failure says through `kind`
 * whether it is a state nothing knows how to clear or a known state that would not
 * clear.
 *
 * The consequence is a contract a calling agent can branch on with a `switch` over three
 * statuses, while an operator reading the same object still sees the whole story.
 */

/** The value types a capability output can hold, matching the Phase 3 `ValueType` set. */
export type OutputValue = string | number | boolean;

/**
 * The engine's own classifications: stable, closed, and each one specific enough to act
 * on without reading the message.
 *
 * They are prefixed, and codes an artifact declares are not, so the prefix answers the
 * first question a reader has about a code in a result: did the engine work this out, or
 * did the capability declare it?
 */
export const ENGINE_FAILURE_CODES = [
  /** The invocation inputs did not match the artifact's declared inputs. */
  'REPLAY_INPUTS_INVALID',
  /** A stored value reference named an input that was not supplied. */
  'REPLAY_PARAMETER_UNRESOLVED',
  /** No locator strategy on the target matched anything. */
  'REPLAY_TARGET_NOT_FOUND',
  /** A strategy matched several elements and none matched exactly one. */
  'REPLAY_AMBIGUOUS_TARGET',
  /** The stored target cannot be resolved by construction. */
  'REPLAY_TARGET_INVALID',
  /** The surface could not reach the location. */
  'REPLAY_NAVIGATION_FAILED',
  /** The target resolved but the interaction did not complete. */
  'REPLAY_ACTION_FAILED',
  /** A `checkpoint` step asserted a state the surface did not show. */
  'REPLAY_CHECKPOINT_FAILED',
  /** A `wait` step's condition never arrived within its budget. */
  'REPLAY_WAIT_TIMEOUT',
  /** The step as a whole outlived its budget. `stepType` says what it was doing. */
  'REPLAY_STEP_TIMEOUT',
  /** Every step ran, but the capability's success condition did not hold. */
  'REPLAY_SUCCESS_CONDITION_FAILED',
  /** The target resolved but its content could not be read. */
  'REPLAY_OUTPUT_EXTRACTION_FAILED',
  /** A declared output was never produced. */
  'REPLAY_OUTPUT_MISSING',
  /** An extracted value could not be read as the declared output type. */
  'REPLAY_OUTPUT_TYPE_MISMATCH',
  /** A step assigned to an output the capability does not declare. */
  'REPLAY_OUTPUT_UNDECLARED',
  /** A recognized condition would not clear within its declared attempts. */
  'REPLAY_RECOVERY_EXHAUSTED',
  /** The surface itself went away mid-run. */
  'REPLAY_SURFACE_UNAVAILABLE',
  /** Genuinely unclassifiable. Never a bucket for failures nobody mapped. */
  'REPLAY_UNEXPECTED_STATE',
] as const;

export type EngineFailureCode = (typeof ENGINE_FAILURE_CODES)[number];

/**
 * A code in a failure result: one of `ENGINE_FAILURE_CODES`, or a code the artifact
 * declared for a known application state, such as `PERMISSION_DENIED`.
 *
 * Open, because a declared code belongs to the capability rather than to the engine and
 * enumerating every capability's codes here would be impossible. It is still a contract:
 * a declared code is validated as screaming snake case, is part of the artifact a
 * reviewer reads, and changes only when the capability is revised. Callers that need a
 * closed set to branch on use `kind`; engine code paths are typed as `EngineFailureCode`,
 * so a typo inside the engine is still a compile error.
 *
 * The `& {}` keeps the engine codes visible to an editor's completion instead of letting
 * the union collapse to a bare `string`, which is the difference between a caller
 * discovering the vocabulary and having to look it up.
 */
export type ReplayFailureCode = EngineFailureCode | (string & {});

/**
 * What class of failure this is, as a closed set a caller can branch on without knowing
 * any individual code.
 *
 * `terminal`: replay does not recognize this state, so it stopped rather than guessing.
 * `recoveryExhausted`: replay recognized the state and its bounded recovery ran out. The
 * distinction matters operationally, because the second means the application really was
 * stuck in a state the capability knows about, not that the capability is wrong.
 * `policy`: nothing went wrong. The deployment does not permit this action, and the
 * system worked. Paging someone about it would be paging them about a rule they wrote.
 */
export type FailureKind = 'terminal' | 'recoveryExhausted' | 'policy';

/** One step that ran to completion, in execution order. */
export interface ReplayStepRecord {
  readonly stepId: string;
  readonly stepType: CapabilityStepType;
  /** How many times the step was executed, including the one that succeeded. */
  readonly attempts: number;
  readonly durationMs: number;
}

/** One recognized condition, and what the declared recovery for it did about it. */
export interface RecoveryRecord {
  /** The artifact's own code for the condition, such as `KNOWN_SESSION_DIALOG`. */
  readonly code: string;
  readonly stepId: string;
  /** Which recovery attempt this was, counting from one. */
  readonly attempt: number;
  /** Whether the step succeeded when it was retried after this recovery. */
  readonly succeeded: boolean;
  readonly durationMs: number;
}

interface ReplayResultBase {
  /** Identifies this run in logs and, later, in evidence. */
  readonly replayId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly completedSteps: readonly ReplayStepRecord[];
  /**
   * Recognized conditions this run met and acted on, in order. Empty for a run that met
   * none, which is what a healthy application produces.
   */
  readonly recoveries: readonly RecoveryRecord[];
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
 *
 * This is not a failure, and a caller that treats it as one will page someone about a
 * member who simply does not exist.
 */
export interface ReplayBusinessOutcome extends ReplayResultBase {
  readonly status: 'businessOutcome';
  /** The artifact's declared code, such as `MEMBER_NOT_FOUND`. */
  readonly code: string;
  /** The artifact's declared description, which is the human-readable message. */
  readonly message: string;
  /** Where the outcome was detected. Absent when the success condition detected it. */
  readonly stepId?: string;
}

/**
 * The automation could not finish. Carries enough to answer which capability, which
 * step, which action, what was expected, and what the surface actually showed.
 *
 * Never carries an invocation value, a credential, or a raw surface exception: `cause`
 * is a rendered one-line summary, not the original error object and not a stack.
 */
export interface ReplayFailure extends ReplayResultBase {
  readonly status: 'failure';
  readonly kind: FailureKind;
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
