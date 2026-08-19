import { createHash } from 'node:crypto';

import type { PolicyOutcome } from '../policy/index.js';
import { sanitizeUrl } from '../redaction.js';
import type { Observation, ObservedControl } from '../surfaces/index.js';

import type { AgentAction, AgentDecisionType } from './AgentDecision.js';

/**
 * What a discovery run remembers about itself.
 *
 * The trace is the input Phase 8 will compile a capability artifact from, so it keeps
 * the validated action and enough context to reconstruct the run. It is deliberately not
 * an artifact: it is ordered by what happened rather than by what should happen again,
 * it contains the steps that failed as well as the ones that worked, and nothing has
 * been parameterized or verified as replayable. Turning one into the other is Phase 8's
 * job and is not started here.
 *
 * It lives in memory. Values a run typed into the application stay on the action, because
 * Phase 8 needs to see them to decide what becomes an input, and they never reach the
 * log or the evidence file, which receive the summaries in this module instead.
 */

/**
 * An observation reduced to what is worth recording and comparing.
 *
 * The URL is sanitized and the text is replaced by its length and a digest, which is
 * enough to answer "did the screen change?" while keeping somebody's account details out
 * of anything that outlives the run. The controls are kept in full, because a role and an
 * accessible name are structure rather than content: what a compiler needs in order to
 * describe a control it must find again, and nothing a user typed.
 *
 * Only `controlCount` reaches the evidence recorder. The list itself stays in memory.
 */
export interface ObservationSummary {
  readonly url: string;
  readonly title: string;
  readonly controlCount: number;
  readonly textLength: number;
  /**
   * The controls that were on screen, by role and accessible name.
   *
   * Kept because Phase 8 builds a capability's success condition from the difference
   * between the first screen and the last: the control that appeared as a result of the
   * workflow is the evidence that the workflow arrived somewhere. A role and an
   * accessible name are structure rather than content, so this carries no value a user
   * typed and nothing read out of a record.
   *
   * The evidence recorder still receives only `controlCount`, so this stays in memory.
   */
  readonly controls: readonly ObservedControl[];
  /** Digest of the sanitized structure, see `fingerprintObservation`. */
  readonly fingerprint: string;
}

/**
 * A deterministic fingerprint of the visible state.
 *
 * Built from the location, the title, and the roles and accessible names of the controls
 * on screen. Text is included only as a digest, so a page that re-rendered the same
 * content fingerprints the same way while a page that now shows a result does not.
 *
 * The limitation is worth stating plainly: this recognizes an identical screen, not a
 * screen that is equivalent in some deeper sense. A page carrying a clock, a session
 * token in the path, or a rotating advertisement changes fingerprint every time, so the
 * repeated-state guard will not catch a loop on one. It is a cheap, explainable check
 * that catches the loop that actually happens, which is an action that changes nothing.
 */
export function fingerprintObservation(observation: Observation): string {
  const controls = observation.controls
    .map((control) => `${control.role}:${control.name}:${String(control.enabled)}`)
    .join('|');
  const material = [
    sanitizeUrl(observation.url),
    observation.title,
    controls,
    createHash('sha256').update(observation.textSummary).digest('hex'),
  ].join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function summarizeObservation(observation: Observation): ObservationSummary {
  return {
    url: sanitizeUrl(observation.url),
    title: observation.title,
    controlCount: observation.controls.length,
    controls: observation.controls,
    textLength: observation.textSummary.length,
    fingerprint: fingerprintObservation(observation),
  };
}

/** How an executed action turned out. A failure here is a step outcome, not a verdict. */
export interface ActionOutcome {
  readonly ok: boolean;
  readonly durationMs: number;
  /** Present when the action did not succeed. One of the replay engine's own codes. */
  readonly code?: string;
  /** Short, already-safe rendering of what went wrong. Never a raw exception. */
  readonly detail?: string;
}

/** One turn of the loop, in the order it happened. */
export interface DiscoveryTraceEntry {
  readonly step: number;
  /** What the model was looking at when it decided. */
  readonly observation: ObservationSummary;
  readonly decisionType: AgentDecisionType;
  /** The model's own one-line rationale. Never private reasoning. */
  readonly summary: string;
  /**
   * The validated action, kept whole because Phase 8 compiles from it. Includes a fill
   * value, which is why a trace is never serialized into evidence.
   */
  readonly action: AgentAction;
  readonly policy: PolicyOutcome;
  readonly outcome: ActionOutcome;
  /** What the surface showed once the action settled. */
  readonly stateAfter: ObservationSummary;
}

/** A value the surface read during the run, and where it came from. */
export interface DiscoveredValue {
  readonly name: string;
  readonly value: string;
  readonly step: number;
}

/**
 * A value the operator supplied for this run, under the name it should be known by.
 *
 * This is what makes deterministic parameterization possible. Discovery types concrete
 * values into an application, and a compiler looking at the finished trace cannot tell
 * which of them are invocation data and which are part of the workflow. Guessing from
 * the shape of a string would be the wrong answer arrived at confidently, so the caller
 * names them instead, and the compiler binds only on an exact whole-value match.
 */
export interface DiscoveryInput {
  /** The name the capability input will carry, for example `memberId`. */
  readonly name: string;
  /** What the run should type. Never persisted into an artifact or into evidence. */
  readonly value: string;
  readonly description?: string;
  /** Declares that the value must be kept out of logs and records by every layer. */
  readonly sensitive?: boolean;
}

/**
 * Everything one discovery run knows about itself.
 *
 * The entries are what happened; the goal, application, and inputs are what it was asked
 * to do. Phase 8 needs both, because an ordered list of actions cannot say which of the
 * values in it were invocation data or where the workflow was supposed to start.
 *
 * It is still not an artifact. It is ordered by what happened rather than by what should
 * happen again, it contains the steps that failed alongside the ones that worked, and
 * nothing in it has been parameterized or shown to be replayable.
 */
export interface DiscoveryTrace {
  readonly runId: string;
  readonly goal: string;
  /** Where the run happened. The entry point is the real URL, not a sanitized one. */
  readonly application: { readonly name: string; readonly entryPoint: string };
  readonly inputs: readonly DiscoveryInput[];
  readonly entries: readonly DiscoveryTraceEntry[];
  /** Values the surface read during the run. Evidence of what worked, never an output. */
  readonly discovered: readonly DiscoveredValue[];
  /**
   * The values the run reported as the answer, already checked against what the
   * application was showing.
   *
   * Kept so compilation can prove it produced a capability that reads the same thing. A
   * compiled extract step can resolve, succeed, and return the wrong element, which is a
   * capability that replays perfectly and answers the wrong question; comparing against
   * these is what turns verification from "it ran" into "it works".
   */
  readonly outputs: Readonly<Record<string, string>>;
}
