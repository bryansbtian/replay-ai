import type { Observation } from '../surfaces/index.js';

import type { DiscoveredValue } from './DiscoveryTrace.js';

/**
 * Everything the model is told, in one place.
 *
 * It is a module rather than a string built inside the engine so that the instructions
 * can be read, reviewed, and diffed like the rest of the system. A prompt is the part of
 * an LLM application that changes behaviour most and is easiest to change by accident.
 *
 * It is also deliberately short. Rules the application can enforce are not written here:
 * the action vocabulary is enforced by a schema, the destinations are enforced by policy,
 * the step count is enforced by the loop guard, and none of them are things a model could
 * grant itself by being asked nicely. What is left is what the model genuinely has to
 * know: what it is looking at, what it may choose between, and how to say so.
 */

/** Roughly a screenful. Enough to tell two states apart, small enough to send every turn. */
const MAX_OBSERVATION_TEXT = 1_500;

/** Recent steps carried into the next prompt. Bounded, so cost does not grow with the run. */
export const MAX_HISTORY_ENTRIES = 5;

export const DISCOVERY_SYSTEM_PROMPT = `You are driving a real application through an automation surface in order to work out how a workflow is performed. You do not write code and you do not control the application directly. You choose one action at a time, and the system carries it out and shows you the result.

Answer with exactly one JSON object and nothing else. No prose, no explanation outside the object, no markdown code fence. Any field not listed below is rejected and ends the run.

There are three decisions.

1. Perform one action:
{"type":"action","action":{...},"summary":"Why this action, in one short sentence"}

2. Report that the goal is met:
{"type":"complete","summary":"What the application is showing that satisfies the goal","outputs":{"balance":"$1,234.56"}}

3. Ask for a person:
{"type":"escalate","reason":"Why you cannot safely continue"}

The actions available are exactly these:

{"type":"navigate","url":"https://example.test/path"}
{"type":"click","target":{...}}
{"type":"fill","target":{...},"value":"text to type"}
{"type":"extract","target":{...},"name":"camelCaseName"}
{"type":"wait","condition":{...}}

A target names one control and lists the ways to find it, best first:

{"description":"Member ID Field","strategies":[{"kind":"role","role":"textbox","name":"Member ID"},{"kind":"label","text":"Member ID"}]}

Strategies are: {"kind":"role","role":"button","name":"Search"}, {"kind":"label","text":"Member ID"}, {"kind":"placeholder","text":"Enter A Member ID"}, {"kind":"attribute","attribute":"data-testid","value":"member-search"}, {"kind":"text","text":"Member Summary"}, {"kind":"css","selector":"#member-id"}. Prefer role, label, and placeholder, because they survive a redesign. Use css only when the observation offers nothing else. A target must match exactly one control, so add a name or a label rather than describing a whole group.

A wait condition is one of: {"type":"targetVisible","target":{...}}, {"type":"targetContainsText","target":{...},"text":"..."}, {"type":"textVisible","text":"..."}, {"type":"urlMatches","pattern":"^https://example\\\\.test/members"}.

Rules:
- Choose exactly one action per turn. React to what the observation actually shows.
- Only target controls and text that appear in the observation. Do not guess at a control you have not seen.
- After an action that submits or loads something, wait for the state you expect before acting on it.
- Use extract to read a value the goal asks for. Report the value you extracted, never a value you assumed.
- Stay inside the application you were given. Do not navigate to an unrelated site.
- Do not claim the goal is complete unless the current observation shows it. If you cannot see the result, keep working or escalate.
- Escalate when the application asks for something you should not decide: a permission, a payment, a confirmation of something irreversible, or a credential you were not given.
- Never output executable code, a script, or a selector to be evaluated.
- Never enter a password, token, or any secret. If the workflow needs one, escalate instead.`;

export interface StepHistoryEntry {
  readonly step: number;
  /** The model's own summary of what it was doing. */
  readonly summary: string;
  /** What the surface did with it. */
  readonly outcome: 'succeeded' | 'failed';
  /** Short, already-safe rendering of a failure, so the next turn can react to it. */
  readonly detail?: string;
}

export interface InstructionInput {
  readonly goal: string;
  readonly applicationName: string;
  readonly entryPoint: string;
  readonly step: number;
  readonly maxSteps: number;
  readonly observation: Observation;
  /** Most recent last. The caller decides how many; see `MAX_HISTORY_ENTRIES`. */
  readonly history: readonly StepHistoryEntry[];
  readonly discovered: readonly DiscoveredValue[];
}

function renderControls(observation: Observation): string {
  if (observation.controls.length === 0) {
    return '  (No Interactive Controls Were Detected)';
  }
  return observation.controls
    .map((control) => {
      if (control.enabled) {
        return `  - ${control.role} "${control.name}"`;
      }
      return `  - ${control.role} "${control.name}" [disabled]`;
    })
    .join('\n');
}

function renderHistory(history: readonly StepHistoryEntry[]): string {
  if (history.length === 0) {
    return '  (Nothing Yet)';
  }
  return history
    .map((entry) => {
      if (entry.detail === undefined) {
        return `  ${entry.step}. ${entry.summary} -> ${entry.outcome}`;
      }
      return `  ${entry.step}. ${entry.summary} -> ${entry.outcome}: ${entry.detail}`;
    })
    .join('\n');
}

function renderDiscovered(discovered: readonly DiscoveredValue[]): string {
  if (discovered.length === 0) {
    return '  (Nothing Read Yet)';
  }
  return discovered.map((value) => `  - ${value.name} = ${value.value}`).join('\n');
}

/**
 * The one turn that changes.
 *
 * A compact state rather than a growing transcript: the goal, a bounded recent history,
 * the values read so far, and the current screen. That is what the next decision actually
 * depends on, and resending the whole conversation every turn would multiply the cost of
 * a run by its length for information the model has already acted on.
 */
export function buildInstruction(input: InstructionInput): string {
  const text = input.observation.textSummary.slice(0, MAX_OBSERVATION_TEXT);
  const truncated = input.observation.textSummary.length > MAX_OBSERVATION_TEXT;

  const lines = [
    `Goal: ${input.goal}`,
    `Application: ${input.applicationName} (${input.entryPoint})`,
    `Step ${input.step} Of At Most ${input.maxSteps}`,
    '',
    'Recent Steps:',
    renderHistory(input.history),
    '',
    'Values Read So Far:',
    renderDiscovered(input.discovered),
    '',
    'Current Observation:',
    `  URL: ${input.observation.url}`,
    `  Title: ${input.observation.title}`,
    '  Controls:',
    renderControls(input.observation),
    '  Visible Text:',
    `${text}`,
  ];

  if (truncated || input.observation.truncated) {
    lines.push('  (The Observation Was Truncated)');
  }
  lines.push('', 'Respond with one JSON decision.');
  return lines.join('\n');
}
