import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  checkpointSchema,
  parameterNameSchema,
  targetSchema,
  type CapabilityStepType,
} from '../artifacts/index.js';
import type { Target } from '../surfaces/index.js';

/**
 * What the model is allowed to say, and the proof that it said it.
 *
 * The model never returns code. It returns one of three decisions, each of which is a
 * plain object this module can validate before anything acts on it. That is the whole
 * safety argument for putting a language model in an automation loop: the model chooses
 * from a vocabulary the application defined, and an answer outside that vocabulary is a
 * validation failure rather than an instruction.
 *
 * Every object is `strictObject`, so an unknown key is rejected. That is a typo guard,
 * and it is also structural: there is no field in which a model could return reasoning,
 * a script, a selector to evaluate, or anything else nobody designed a use for, so
 * nothing downstream has to remember not to read one.
 *
 * The action vocabulary is the surface's own. Targets and conditions are the Phase 2
 * models, imported from the artifact contract that already expresses them as schemas
 * rather than restated here, so a control the model describes is described exactly the
 * way a stored step describes one.
 */

/** A concise rationale for a log line and a human reviewer. Never private reasoning. */
const MAX_SUMMARY_LENGTH = 200;

const summarySchema = z
  .string()
  .min(1, 'must not be empty')
  .max(MAX_SUMMARY_LENGTH, `must be at most ${MAX_SUMMARY_LENGTH} characters`);

/** Bounded for the same reason a stored literal is: a value is data, not a payload. */
const valueSchema = z.string().max(MAX_SUMMARY_LENGTH, 'must be at most 200 characters');

/**
 * The actions a `ComputerSurface` can actually perform.
 *
 * Derived from what the surface offers rather than from what a model might imagine, and
 * closed: an action name nobody implemented fails validation instead of reaching a
 * dispatch that would have to decide what to do with it.
 *
 * `screenshot` and `observe` are absent because they are the loop's own business. The
 * model is shown an observation on every turn; letting it spend a step asking for one
 * would be a step that cannot make progress.
 */
export const agentActionSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({ type: z.literal('navigate'), url: z.url('must be an absolute URL') }),
    z.strictObject({ type: z.literal('click'), target: targetSchema }),
    z.strictObject({ type: z.literal('fill'), target: targetSchema, value: valueSchema }),
    z.strictObject({
      type: z.literal('extract'),
      target: targetSchema,
      /** Names the discovered value. Phase 8 decides whether it becomes an artifact output. */
      name: parameterNameSchema,
    }),
    z.strictObject({ type: z.literal('wait'), condition: checkpointSchema }),
  ],
  { error: 'must be one of the supported actions: navigate, click, fill, extract, wait' },
);

/**
 * One decision, exactly one turn of the loop.
 *
 * `complete` and `escalate` are terminal claims rather than commands: the engine checks
 * the first against what the surface shows and treats the second as a request for a
 * person, which is Phase 9's to answer.
 */
export const agentDecisionSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({
      type: z.literal('action'),
      action: agentActionSchema,
      summary: summarySchema,
    }),
    z.strictObject({
      type: z.literal('complete'),
      summary: summarySchema,
      /**
       * Values the goal asked for. Checked against the observation before the run is
       * called a success, because a model asserting a balance is not the same as an
       * application showing one.
       */
      outputs: z.record(parameterNameSchema, valueSchema).default({}),
    }),
    z.strictObject({ type: z.literal('escalate'), reason: summarySchema }),
  ],
  { error: 'must be one of the supported decisions: action, complete, escalate' },
);

export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentActionType = AgentAction['type'];
export type AgentDecision = z.infer<typeof agentDecisionSchema>;
export type AgentDecisionType = AgentDecision['type'];
export type ActionDecision = Extract<AgentDecision, { type: 'action' }>;
export type CompleteDecision = Extract<AgentDecision, { type: 'complete' }>;
export type EscalateDecision = Extract<AgentDecision, { type: 'escalate' }>;

/**
 * The action vocabulary as a value, and the assertion that every action names a step type
 * the safety boundary already understands.
 *
 * Policy evaluates a `CapabilityStepType`, so a model-proposed action has to be one. That
 * is not a coincidence to be maintained by hand: if an action were added here that policy
 * had no name for, the constraint below would stop compiling rather than let an action
 * through a guardrail that could not describe it.
 */
export const AGENT_ACTION_TYPES = [
  'navigate',
  'click',
  'fill',
  'extract',
  'wait',
] as const satisfies readonly (AgentActionType & CapabilityStepType)[];

/** The outcome of reading a model response. Never thrown: bad output is expected input. */
export type DecisionParse =
  | { readonly ok: true; readonly decision: AgentDecision }
  | { readonly ok: false; readonly issue: string };

/**
 * Finds the JSON object in a model response.
 *
 * A model asked for JSON usually returns JSON, and sometimes returns JSON inside a code
 * fence or with a sentence in front of it. Scanning for the first balanced object is
 * tolerant of that without being tolerant of anything else: what comes back is still
 * parsed and still validated, so a lenient reader cannot become a lenient contract.
 */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function describeIssues(error: z.ZodError): string {
  const lines = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.join('.');
    if (path === '') {
      return issue.message;
    }
    return `${path}: ${issue.message}`;
  });
  return lines.join('; ');
}

/**
 * Turns a model response into a decision, or says why it is not one.
 *
 * This is the only way a decision is ever produced. There is no cast, no partial parse,
 * and no path that treats an unvalidated object as a decision, which is what makes
 * "invalid model output never reaches policy or the surface" a property of the code
 * rather than a habit.
 */
export function parseAgentDecision(text: string): DecisionParse {
  const json = extractJsonObject(text);
  if (json === undefined) {
    return { ok: false, issue: 'the response contained no JSON object' };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(json);
  } catch {
    return { ok: false, issue: 'the response was not valid JSON' };
  }

  const parsed = agentDecisionSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, issue: describeIssues(parsed.error) };
  }
  return { ok: true, decision: parsed.data };
}

/** Short digest of a value, so a repeated action can be recognized without keeping one. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * The strategies, in stored order.
 *
 * The description is deliberately left out: it is the model's wording for a control, and
 * two decisions that would operate the same control by the same strategies are the same
 * action however differently they were described. Key order is stable because every
 * strategy came out of one schema.
 */
function describeTarget(target: Target): string {
  return JSON.stringify(target.strategies);
}

/**
 * A stable fingerprint of what an action would do.
 *
 * Built from the normalized action rather than from the model's wording, so that two
 * decisions described differently but doing the same thing are recognized as the same
 * thing, which is what loop protection needs.
 *
 * A `fill` contributes a digest of its value rather than the value. A member reference or
 * a password is exactly what a fingerprint would otherwise carry into a log, and a digest
 * answers the only question the guard asks: is this the same value as last time?
 */
export function fingerprintAction(action: AgentAction): string {
  switch (action.type) {
    case 'navigate':
      return `navigate:${action.url}`;
    case 'click':
      return `click:${describeTarget(action.target)}`;
    case 'fill':
      return `fill:${describeTarget(action.target)}:${digest(action.value)}`;
    case 'extract':
      return `extract:${action.name}:${describeTarget(action.target)}`;
    case 'wait':
      return `wait:${JSON.stringify(action.condition)}`;
  }
}

/** How an action reads in a log line or an evidence record. Never carries a value. */
export function describeAction(action: AgentAction): string {
  switch (action.type) {
    case 'navigate':
      return `navigate to ${action.url}`;
    case 'click':
      return `click "${action.target.description}"`;
    case 'fill':
      return `fill "${action.target.description}"`;
    case 'extract':
      return `extract "${action.name}" from "${action.target.description}"`;
    case 'wait':
      return `wait for ${action.condition.type}`;
  }
}
