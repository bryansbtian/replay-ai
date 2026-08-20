import type { Observation } from '../surfaces/index.js';

import type { DiscoveredValue, DiscoveryInput } from './DiscoveryTrace.js';

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

Every answer has a top-level "type" of exactly "action", "complete", or "escalate".

A target is always an object with a "description" and a "strategies" array. A strategy on its own is never a target. This is the mistake to avoid:

WRONG: "target":{"kind":"role","role":"button","name":"Search"}
RIGHT: "target":{"description":"Search Button","strategies":[{"kind":"role","role":"button","name":"Search"}]}

These are complete answers. Copy their shape exactly.

Click a control:
{"type":"action","action":{"type":"click","target":{"description":"Search Button","strategies":[{"kind":"role","role":"button","name":"Search"},{"kind":"text","text":"Search"}]}},"summary":"Submit the member search form"}

Type into a field:
{"type":"action","action":{"type":"fill","target":{"description":"Member ID Field","strategies":[{"kind":"label","text":"Member ID"},{"kind":"placeholder","text":"Enter A Member ID"}]},"value":"12345"},"summary":"Enter the member reference"}

Read a value the goal asks for:
{"type":"action","action":{"type":"extract","target":{"description":"Savings Balance","strategies":[{"kind":"attribute","attribute":"data-field","value":"savings-balance"}]},"name":"savingsBalance"},"summary":"Read the savings balance"}

Wait for a state to arrive:
{"type":"action","action":{"type":"wait","condition":{"type":"textVisible","text":"Member Summary"}},"summary":"Wait for the member summary to load"}

Go to a page:
{"type":"action","action":{"type":"navigate","url":"https://example.test/members"},"summary":"Open the member list"}

Report that the goal is met:
{"type":"complete","summary":"The member summary is visible and shows the savings balance","outputs":{"savingsBalance":"5234.17"}}

Report that a search listing is on screen:
{"type":"complete","summary":"The restaurant search results for the requested cuisine are visible","outputs":{}}

Ask for a person:
{"type":"escalate","reason":"The application is asking to approve a payment, which I should not decide"}

The only action types are navigate, click, fill, extract, and wait. There are no others.

The only strategy kinds are: {"kind":"role","role":"button","name":"Search"}, {"kind":"label","text":"Member ID"}, {"kind":"placeholder","text":"Enter A Member ID"}, {"kind":"attribute","attribute":"data-testid","value":"member-search"}, {"kind":"text","text":"Member Summary"}, {"kind":"css","selector":"#member-id"}. Prefer role, label, and placeholder, because they survive a redesign. Use css only when the observation offers nothing else. A target must match exactly one control, so add a name or a label rather than describing a whole group.

The only wait conditions are: {"type":"targetVisible","target":{"description":"...","strategies":[...]}}, {"type":"targetContainsText","target":{"description":"...","strategies":[...]},"text":"..."}, {"type":"textVisible","text":"..."}, {"type":"urlMatches","pattern":"^https://example\\\\.test/members"}.

Rules:
- Choose exactly one action per turn. React to what the observation actually shows.
- Only target controls and text that appear in the observation. Do not guess at a control you have not seen.
- After you submit a form or click something that loads a result, look at the new observation before waiting. Wait only when the outcome the goal asked for is not in the observation yet.
- Never repeat an action you have already carried out. If the screen has not changed yet and the goal is still not visible, wait for a phrase that will appear, taken from the goal, rather than doing the same click or fill again. Repeating an action ends the run.
- A wait must name a short phrase you expect to appear, copied from the kind of result the goal asked for, such as a result count. Do not invent a heading like "Search Results" that the page never shows. Waiting for something already listed in the observation succeeds instantly and wastes the turn.
- Work through the whole goal. Filling a field is not submitting it, and submitting is not reading the answer.
- Use extract to read a value the goal asks for. Report the value you extracted, never a value you assumed.
- Every value name, in an extract action and in the outputs of a complete decision, is camelCase: memberName, savingsBalance, accountNumber. Not member_name, not MemberName, not "Member Name". A name in any other shape is rejected and the turn is wasted.
- Read a value the goal asks for with an extract action even when the observation text already shows it. This run is being recorded as a workflow that will be replayed for a different member, and only an extract action teaches it where to read that value again. A value reported in a complete decision and never extracted is thrown away.
- If an action fails, do not repeat it unchanged. Target the control a different way, or take a different route to the goal. The same action failing three times ends the run.
- Give a target more than one strategy when the observation supports it, so a control that one strategy misses is still found.
- To extract a printed value such as a balance, target it with the attribute strategy listed under Readable Values. A heading near the value is not the value, and text strategies match the label rather than what it labels. When no readable value is listed, target the element that states the value itself, such as the heading that reports a result count.
- Stay inside the application you were given. Do not navigate to an unrelated site.
- Do not claim the goal is complete unless the current observation shows it. If you cannot see the result, keep working or escalate.
- Once Visible Text shows the listing, result count, or page the goal asked to reach, extract every value the goal asked you to read, and then answer with complete. A goal that says read, report, or how many is not met by arriving at the screen that shows it. Do not open a result, book, join a queue, log in, or sign up unless the goal asked for that.
- Anything listed under Values Read So Far you already have; do not read it again.
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
  /**
   * The values this run was given, if any.
   *
   * Shown so the run types exactly what it was handed rather than a value read out of the
   * goal's prose. Compilation later binds a filled value to an input by exact match, so a
   * model that improvised an equivalent-looking string would produce a workflow that
   * cannot be parameterized.
   */
  readonly inputs: readonly DiscoveryInput[];
  /**
   * Whether this screen is the one the previous action left behind unchanged.
   *
   * The loop fingerprints every observation in order to detect a stuck run, so it already
   * knows this and the model does not: a model is shown one screen at a time and cannot
   * tell a page that never updated from a page that updated to look the same. Saying so is
   * reporting a fact the application measured, and it is the difference between a model
   * pressing the button again and waiting for the result it already asked for.
   */
  readonly stateUnchanged?: boolean;
  /**
   * Why the previous answer this turn was not a decision.
   *
   * Present only on a re-ask. It is the validator's own words about the shape of the
   * object, never the rejected text, so nothing the model wrote is fed back to it as
   * though the system had accepted it.
   */
  readonly rejection?: string;
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

/**
 * The values on the page that can be addressed by a stable attribute.
 *
 * Listed separately from the controls because they are a different kind of thing: not
 * something to operate, but the only reliable way to target a printed value such as a
 * balance, which has no role and no accessible name.
 */
function renderValues(observation: Observation): string {
  if (observation.values.length === 0) {
    return '  (No Addressable Values Were Detected)';
  }
  return observation.values
    .map(
      (value) =>
        `  - {"kind":"attribute","attribute":"${value.attribute}","value":"${value.name}"}`,
    )
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

/**
 * The values the run was given, exactly as they must be typed.
 *
 * A sensitive value is named and not shown. Nothing in the current workflow needs one,
 * and a prompt is the last place a secret should be pasted into by default.
 */
function renderInputs(inputs: readonly DiscoveryInput[]): string {
  if (inputs.length === 0) {
    return '  (None Supplied)';
  }
  return inputs
    .map((input) => {
      if (input.sensitive === true) {
        return `  - ${input.name} (supplied, not shown)`;
      }
      return `  - ${input.name} = ${input.value}`;
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
    'Values To Use:',
    renderInputs(input.inputs),
    '',
    'Values Read So Far:',
    renderDiscovered(input.discovered),
    '',
    'Current Observation:',
    `  URL: ${input.observation.url}`,
    `  Title: ${input.observation.title}`,
    '  Controls:',
    renderControls(input.observation),
    '  Readable Values:',
    renderValues(input.observation),
    '  Visible Text:',
    `${text}`,
  ];

  if (truncated || input.observation.truncated) {
    lines.push('  (The Observation Was Truncated)');
  }

  if (input.stateUnchanged === true) {
    lines.push(
      '',
      'This screen is identical to the one before your last action. Do not repeat that action. If Visible Text or the URL already shows the goal is met, answer with complete now. Otherwise choose a different approach. Do not wait for the same text again.',
    );
  }

  if (input.rejection !== undefined) {
    lines.push(
      '',
      `Your previous answer was rejected: ${input.rejection}`,
      'Answer again with one valid JSON decision and no other text.',
    );
    return lines.join('\n');
  }

  if (input.discovered.length > 0) {
    // Stated at the point of decision rather than only in the standing rules. A value
    // already read is the single strongest signal that the next answer should be a
    // completion, and a small model reliably keeps acting unless it is said here.
    const names = input.discovered.map((value) => value.name).join(', ');
    lines.push(
      '',
      `You have already read: ${names}. If that is everything the goal asked for, answer with complete now and report those values in "outputs". Do not read them again.`,
    );
  }

  lines.push('', 'Respond with one JSON decision.');
  return lines.join('\n');
}
