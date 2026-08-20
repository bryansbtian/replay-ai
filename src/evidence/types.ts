import type { PolicySummary } from '../policy/index.js';

/**
 * What a run leaves behind.
 *
 * Evidence is not a copy of the developer log. A log is a stream a person watches while
 * something runs; evidence is a durable, sanitized record of one automation run, written
 * so that somebody who was not there can answer what ran, what it was allowed to do,
 * what happened, and where it stopped.
 *
 * That difference is why the event vocabulary below is closed. A log takes whatever a
 * call site felt like including; an evidence event is one of a known set of things that
 * can happen to a run, which is what makes the file worth reading months later.
 */

/**
 * Event names are snake_case, matching the convention for machine-readable records, and
 * distinct from the Title Case labels the same moments produce in a log.
 */
export const RUN_EVENT_NAMES = [
  'run_started',
  'policy_evaluated',
  'policy_blocked',
  'step_started',
  'step_completed',
  'step_failed',
  'checkpoint_passed',
  'checkpoint_failed',
  'business_outcome_detected',
  'recovery_attempted',
  'recovery_exhausted',
  'screenshot_captured',
  'run_completed',
  // Discovery. The two loops share the vocabulary where they share a moment (a policy
  // decision is a policy decision), and name their own where they do not: a replay
  // executes a stored step, a discovery run carries out an action a model just proposed.
  'discovery_started',
  'observation_captured',
  'model_request',
  'model_decision',
  'model_response_invalid',
  'action_started',
  'action_completed',
  'action_failed',
  'goal_completed',
  'escalation_requested',
  'discovery_stopped',
  // Human handoff. Recorded into the run that paused rather than into a record of its own:
  // a person taking over is part of what happened to that run, and a separate timeline
  // would be two accounts of one event that a reader has to reconcile.
  'intervention_requested',
  'automation_paused',
  'human_control_started',
  'human_action',
  'human_control_ended',
  'automation_resumed',
  'resume_failed',
  'intervention_timeout',
  'session_aborted',
] as const;

export type RunEventName = (typeof RUN_EVENT_NAMES)[number];

/**
 * One line of `events.jsonl`.
 *
 * `fields` is deliberately loose in type and strict in practice: it passes through the
 * shared redaction rules before it is written, and every call site is inside this
 * repository rather than in a caller's hands.
 */
export interface RunEvent {
  readonly event: RunEventName;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** What is known about a replay when it starts. */
export interface ReplayStartRecord {
  /** Optional on this arm so that a replay reads the way it always did. */
  readonly kind?: 'replay';
  readonly runId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly capabilityName: string;
  /** Names only. A value is never persisted, so neither is a hash of one. */
  readonly inputNames: readonly string[];
  readonly policy: PolicySummary;
}

/**
 * What is known about a discovery run when it starts.
 *
 * There is no capability, because working out whether one exists is what the run is for.
 * What it has instead is the goal it was given and where it started, which are the two
 * things somebody reading the directory later needs in order to know what they are
 * looking at.
 */
export interface DiscoveryStartRecord {
  readonly kind: 'discovery';
  readonly runId: string;
  /** The operator's own words. Never a credential, and never a value read from a screen. */
  readonly goal: string;
  /** Where the run started, already sanitized. */
  readonly target: string;
  readonly policy: PolicySummary;
}

/**
 * What a run says about itself when it starts.
 *
 * A union rather than a bag of optional fields, so that neither kind of run can be
 * recorded with half of the other one's identity.
 */
export type RunStartRecord = ReplayStartRecord | DiscoveryStartRecord;

/**
 * How a run ended, in evidence terms.
 *
 * Mirrors the replay result contract without importing it, so that the evidence package
 * stays below replay and a future discovery run can be recorded the same way.
 */
export interface RunOutcomeRecord {
  /** `escalation` belongs to discovery: a run that needs a person has not failed. */
  readonly status: 'success' | 'businessOutcome' | 'failure' | 'escalation';
  readonly code?: string;
  /**
   * Which class of failure ended the run, such as `terminal` or `policy`.
   *
   * Named apart from the manifest's own `kind`, which says whether this was a replay or a
   * discovery run. One field for both would mean a failed replay's record no longer says
   * it was a replay, and a failed run is the one a reader most needs to find.
   */
  readonly failureKind?: string;
  readonly stepId?: string;
  readonly durationMs: number;
  readonly completedSteps: number;
  readonly recoveries: number;
  /** Declared output names. The values are the caller's answer, not the record's. */
  readonly outputNames?: readonly string[];
}

/**
 * The durable record of one run.
 *
 * A recorder never throws for an event or a screenshot: losing one line of observability
 * must not change what an automation did. It does throw for the manifest, because a run
 * directory with no metadata is not evidence, and silently producing one would be worse
 * than saying so.
 */
export interface EvidenceRecorder {
  readonly runId: string;
  /** Where this run's evidence lives, for a caller that wants to print or open it. */
  readonly directory: string;
  /**
   * Whether a capture is worth taking. Asked before the surface is driven, so a caller
   * that is recording nothing does not pay for an image nobody will store.
   */
  readonly capturesScreenshots: boolean;
  /** Problems met while writing evidence. Recorded in the manifest, never thrown. */
  readonly warnings: readonly string[];
  start(record: RunStartRecord): Promise<void>;
  recordEvent(event: RunEvent): Promise<void>;
  /** @returns the stored file name, or `undefined` when the capture could not be kept. */
  saveScreenshot(label: string, data: Uint8Array): Promise<string | undefined>;
  complete(outcome: RunOutcomeRecord): Promise<void>;
}

/**
 * The recorder used when a caller wants no evidence, such as a unit test driving the
 * engine against a scripted surface.
 *
 * A no-op object rather than an optional dependency, so the engine has one code path and
 * no `if (evidence !== undefined)` at every event.
 */
export const NO_EVIDENCE: EvidenceRecorder = {
  runId: '',
  directory: '',
  capturesScreenshots: false,
  warnings: [],
  start: (): Promise<void> => Promise.resolve(),
  recordEvent: (): Promise<void> => Promise.resolve(),
  saveScreenshot: (): Promise<string | undefined> => Promise.resolve(undefined),
  complete: (): Promise<void> => Promise.resolve(),
};
