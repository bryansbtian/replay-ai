import type { DiscoveryTraceEntry } from './DiscoveryTrace.js';

/**
 * What a discovery run hands back.
 *
 * Three terminal statuses, mirroring the shape replay already uses so that a caller
 * reads one vocabulary across the system: the run reached the goal, the run stopped, or
 * the run needs a person. Everything else a run met on the way is in the trace.
 *
 * The escalation arm is the seam Phase 9 builds on. It is a result rather than an
 * exception because a run that needs a person has not failed: the session is still open,
 * the trace is still valid, and the only thing missing is the decision nobody automated.
 */

/** The reasons a run stops without reaching the goal. Closed, and each one is actionable. */
export const DISCOVERY_FAILURE_CODES = [
  /** The run used its whole step allowance. */
  'DISCOVERY_MAX_STEPS_EXCEEDED',
  /** The run used its whole time allowance. */
  'DISCOVERY_DEADLINE_EXCEEDED',
  /** The same action was proposed over and over with nothing changing. */
  'DISCOVERY_REPEATED_ACTION',
  /** Actions kept being applied and the screen kept looking the same. */
  'DISCOVERY_REPEATED_STATE',
  /** Too many proposed actions in a row could not be carried out. */
  'DISCOVERY_DEAD_END',
  /** The deployment's policy refused the proposed action. Nothing went wrong. */
  'DISCOVERY_POLICY_BLOCKED',
  /** The model answered with something that is not a decision. */
  'DISCOVERY_MODEL_RESPONSE_INVALID',
  /** The provider could not be used: credentials, rate limit, timeout, outage. */
  'DISCOVERY_MODEL_UNAVAILABLE',
  /** The surface itself went away, so there is nothing left to discover against. */
  'DISCOVERY_SURFACE_UNAVAILABLE',
  /** The model claimed the goal was met and the surface did not support the claim. */
  'DISCOVERY_COMPLETION_UNVERIFIED',
] as const;

export type DiscoveryFailureCode = (typeof DISCOVERY_FAILURE_CODES)[number];

/**
 * What class of stop this is, as a closed set a caller can branch on without reading any
 * individual code.
 *
 * `policy` is separated for the same reason replay separates it: nothing went wrong, so
 * nobody should be paged. `provider` is separated because it says the model layer failed
 * rather than the workflow, which is a different person's problem.
 */
export type DiscoveryFailureKind = 'terminal' | 'policy' | 'provider';

interface DiscoveryResultBase {
  readonly runId: string;
  readonly goal: string;
  /** Where the run started, sanitized. */
  readonly target: string;
  /** Model decisions carried out, which is the length of the trace. */
  readonly stepCount: number;
  readonly durationMs: number;
  /**
   * The ordered record of the run. In-memory only: it carries the values the run typed
   * into the application, so it is never serialized into evidence or printed.
   */
  readonly trace: readonly DiscoveryTraceEntry[];
}

/**
 * The goal was reached, and the final observation supported the claim.
 *
 * `outputs` are the values the run read out of the application. They are discovery's own
 * result, not the Phase 3 typed capability outputs: nothing here has been declared, typed,
 * or promised to a caller, and deciding which of them becomes a capability output is
 * Phase 8's work.
 */
export interface DiscoverySuccess extends DiscoveryResultBase {
  readonly status: 'success';
  readonly outputs: Readonly<Record<string, string>>;
  /** The model's closing rationale, for a person reading the run. */
  readonly summary: string;
}

export interface DiscoveryFailure extends DiscoveryResultBase {
  readonly status: 'failure';
  readonly kind: DiscoveryFailureKind;
  readonly code: DiscoveryFailureCode;
  readonly message: string;
  /** What the run was trying to do when it stopped. Never carries a value. */
  readonly lastAction?: string;
}

/**
 * The run needs a person: the model asked for one, or policy said this action needs
 * approval and there is nobody to give it.
 *
 * Phase 9 turns this into a live handoff. Nothing here pauses, holds, or hands over a
 * session today, and the result says so by being terminal.
 */
export interface DiscoveryEscalation extends DiscoveryResultBase {
  readonly status: 'escalation';
  /** Why a person is needed, in one sentence. */
  readonly reason: string;
  /** `model` when the model asked, `policy` when the guardrail required approval. */
  readonly source: 'model' | 'policy';
  readonly lastAction?: string;
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryFailure | DiscoveryEscalation;
