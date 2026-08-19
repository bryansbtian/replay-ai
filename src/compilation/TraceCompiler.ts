import type {
  BusinessOutcomeDefinition,
  CapabilityStep,
  CapabilityValue,
  Checkpoint,
  InputDefinition,
  OutputDefinition,
} from '../artifacts/index.js';
import type { AgentAction, DiscoveryInput, DiscoveryTrace } from '../discovery/index.js';
import {
  createTarget,
  TARGET_ROLES,
  type ObservedControl,
  type Target,
} from '../surfaces/index.js';

import type { CompilationRequest } from './CompilationRequest.js';
import { stepIdFor, UniqueStepIds } from './stepNaming.js';

/**
 * The transformation at the centre of this phase: one run's history becomes a workflow.
 *
 * These are genuinely different documents. A trace says what happened, in the order it
 * happened, including the attempts that failed and the concrete values that were typed.
 * An artifact says how the capability is performed, with the invocation data lifted out
 * into named parameters and a condition that proves it arrived. Serializing the first and
 * calling it the second would produce a file that replays one member's lookup forever.
 *
 * Everything here is deterministic. The same trace and the same request produce the same
 * artifact, byte for byte, which is what makes a compiler reviewable: nothing in this file
 * asks a model what it thinks the workflow was.
 */

/** The target as the artifact schema parses it: the same model, with a mutable array. */
type ArtifactTarget = Extract<CapabilityStep, { type: 'click' }>['target'];

/** Why a trace could not become a workflow. Thrown internally, mapped to a result above. */
export class CompilationProblem extends Error {
  constructor(
    readonly stage: 'normalization' | 'parameterization',
    message: string,
  ) {
    super(message);
    this.name = 'CompilationProblem';
  }
}

/** The artifact as an unvalidated object. It is parsed before anything else touches it. */
export type ArtifactDraft = Record<string, unknown>;

export interface CompiledDraft {
  readonly draft: ArtifactDraft;
  /** Actions the trace recorded that did not succeed, so they were not compiled. */
  readonly skippedActions: number;
}

/**
 * The actions worth compiling.
 *
 * Only the ones that succeeded. A discovery run is allowed to be wrong on the way to being
 * right: a locator that did not resolve is information the next turn reacted to, and
 * replaying it would just reproduce the mistake more reliably. This is a deliberate
 * omission rather than a silent one, and the count is reported in the result.
 */
function successfulActions(trace: DiscoveryTrace): readonly AgentAction[] {
  const actions: AgentAction[] = [];
  for (const entry of trace.entries) {
    if (entry.outcome.ok) {
      actions.push(entry.action);
    }
  }
  return actions;
}

/**
 * Normalizes a target the model described into one an artifact should carry.
 *
 * `createTarget` is the Phase 2 helper replay already resolves through, so the compiled
 * target is ordered exactly the way resolution will attempt it, and the artifact says what
 * will actually happen rather than what the model happened to list first. Duplicate
 * strategies are dropped: a model asked for more than one way to find a control sometimes
 * gives the same way twice, and an artifact is something people read.
 */
function normalizeTarget(target: Target): ArtifactTarget {
  const seen = new Set<string>();
  const strategies = target.strategies.filter((strategy) => {
    const key = JSON.stringify(strategy);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const ordered = createTarget(target.description, strategies);
  // Copied into a mutable array because that is the shape the artifact schema parses to.
  // The two target models are otherwise identical, which `steps.ts` asserts at compile time.
  return { description: ordered.description, strategies: [...ordered.strategies] };
}

function normalizeCheckpoint(condition: Checkpoint): Checkpoint {
  if (condition.type === 'targetVisible') {
    return { type: 'targetVisible', target: normalizeTarget(condition.target) };
  }
  if (condition.type === 'targetContainsText') {
    return {
      type: 'targetContainsText',
      target: normalizeTarget(condition.target),
      text: condition.text,
    };
  }
  return condition;
}

/**
 * Decides whether a value the run typed was invocation data or part of the workflow.
 *
 * Exact whole-value equality against a named input, and nothing else. No substring
 * matching, no pattern recognition, no similarity: those find the value the caller meant
 * and eventually also find one they did not, and a wrongly parameterized workflow constant
 * is a capability that breaks the first time it is invoked with a real argument.
 *
 * A value matching no input stays a literal, which is the right answer for the parts of a
 * workflow that never vary, such as choosing the Savings tab.
 */
function bindValue(value: string, inputs: readonly DiscoveryInput[]): CapabilityValue {
  const matches = inputs.filter((input) => input.value === value);
  if (matches.length === 0) {
    return { source: 'literal', value };
  }
  if (matches.length > 1) {
    const names = matches.map((match) => match.name).join(', ');
    throw new CompilationProblem(
      'parameterization',
      `A value typed during discovery matches more than one supplied input (${names}), so there is no single correct parameter to bind it to. Give those inputs distinct values and run discovery again.`,
    );
  }
  // The value itself does not travel into the artifact. Only the name does, which is what
  // keeps a member reference out of a file that gets committed and reviewed.
  return { source: 'input', name: matches[0]?.name ?? '' };
}

/** Turns one discovered action into one artifact step. */
function toStep(
  action: AgentAction,
  id: string,
  inputs: readonly DiscoveryInput[],
): CapabilityStep {
  switch (action.type) {
    case 'navigate':
      return { id, type: 'navigate', url: action.url, risk: 'safe' };
    case 'click':
      return { id, type: 'click', target: normalizeTarget(action.target), risk: 'safe' };
    case 'fill':
      return {
        id,
        type: 'fill',
        target: normalizeTarget(action.target),
        value: bindValue(action.value, inputs),
        risk: 'safe',
      };
    case 'extract':
      return { id, type: 'extract', target: normalizeTarget(action.target), output: action.name };
    case 'wait':
      return { id, type: 'wait', condition: normalizeCheckpoint(action.condition) };
  }
}

/**
 * The control that appeared because the workflow ran.
 *
 * The success condition has to prove the run arrived somewhere, and the difference between
 * the first screen and the last is the evidence the run itself produced for that. A
 * heading or a region is preferred because those are what applications use to name the
 * thing they just showed you, which makes the condition read like the goal rather than
 * like the last button that was pressed.
 */
function arrivedControl(trace: DiscoveryTrace): ObservedControl | undefined {
  const compiled = trace.entries.filter((entry) => entry.outcome.ok);
  const first = trace.entries[0]?.observation.controls ?? [];
  const last = compiled.at(-1)?.stateAfter.controls ?? [];

  const before = new Set(first.map((control) => `${control.role}:${control.name}`));
  const appeared = last.filter((control) => {
    if (control.name.trim() === '') {
      return false;
    }
    return !before.has(`${control.role}:${control.name}`);
  });

  const landmark = appeared.find((control) => {
    return control.role === 'heading' || control.role === 'region';
  });
  if (landmark !== undefined) {
    return landmark;
  }
  return appeared[0];
}

/**
 * Builds the condition that says the capability worked.
 *
 * A role-based condition when the observed role is one the target model knows, and visible
 * text otherwise. Both are checked by the surface against the live application at replay
 * time, which is the point: an artifact whose success condition cannot fail is an artifact
 * that cannot tell you it broke.
 */
function successConditionFor(trace: DiscoveryTrace): Checkpoint {
  const control = arrivedControl(trace);
  if (control === undefined) {
    throw new CompilationProblem(
      'normalization',
      'The successful run ended on the screen it started from, so there is no observed state that proves the workflow arrived anywhere. A capability without a real success condition would report success for a run that did nothing.',
    );
  }

  const role = TARGET_ROLES.find((known) => known === control.role);
  if (role === undefined) {
    return { type: 'textVisible', text: control.name };
  }
  return {
    type: 'targetVisible',
    target: normalizeTarget(
      createTarget(control.name, [{ kind: 'role', role, name: control.name }]),
    ),
  };
}

/**
 * Declares the inputs the compiled steps actually reference.
 *
 * A supplied input that no step used is a compilation failure rather than a declaration
 * that is quietly dropped. Semantic validation would reject it anyway, and saying so here
 * says why: the run never typed that value, so the workflow does not take it.
 */
function inputDefinitions(
  trace: DiscoveryTrace,
  steps: readonly CapabilityStep[],
): InputDefinition[] {
  const referenced = new Set<string>();
  for (const step of steps) {
    if (step.type === 'fill' && step.value.source === 'input') {
      referenced.add(step.value.name);
    }
  }

  const definitions: InputDefinition[] = [];
  for (const input of trace.inputs) {
    if (!referenced.has(input.name)) {
      throw new CompilationProblem(
        'parameterization',
        `Input "${input.name}" was supplied but the discovery run never typed its value, so the compiled workflow has nothing to bind it to.`,
      );
    }
    definitions.push({
      name: input.name,
      // Every invocation value arrives from a command line or a JSON call as text, and
      // replay has no deterministic conversion to offer beyond that.
      type: 'string',
      required: true,
      description: input.description ?? `Value supplied for ${input.name}.`,
      sensitive: input.sensitive ?? false,
    });
  }
  return definitions;
}

/**
 * Declares an output for every extract step, and nothing else.
 *
 * The value the discovery run read is deliberately absent. An artifact that stored
 * `"5234.17"` would return one member's balance to every future caller; what it stores
 * instead is the extract step that reads the balance again each time it runs.
 */
function outputDefinitions(
  steps: readonly CapabilityStep[],
  request: CompilationRequest,
): OutputDefinition[] {
  const described = new Map(request.outputs?.map((output) => [output.name, output]) ?? []);
  const definitions: OutputDefinition[] = [];

  for (const step of steps) {
    if (step.type !== 'extract') {
      continue;
    }
    const supplied = described.get(step.output);
    definitions.push({
      name: step.output,
      // Conservative on purpose. The surface reads text, and nothing in replay parses a
      // currency string into a number, so claiming `number` would be a promise the engine
      // cannot keep.
      type: 'string',
      description: supplied?.description ?? `Value read from the application as ${step.output}.`,
    });
  }
  return definitions;
}

export interface CompileOptions {
  readonly now: () => Date;
}

/**
 * Compiles a successful discovery trace into an artifact draft.
 *
 * The result is deliberately untyped as an artifact. It is a plain object that has to
 * survive `parseCapabilityArtifact` like anything read off a disk, because a compiler that
 * trusted its own output would be the one component allowed to write an invalid file.
 */
export function compileDraft(
  trace: DiscoveryTrace,
  request: CompilationRequest,
  options: CompileOptions,
): CompiledDraft {
  const actions = successfulActions(trace);
  if (actions.length === 0) {
    throw new CompilationProblem(
      'normalization',
      'The discovery run carried out no successful action, so there is no workflow to compile.',
    );
  }

  const ids = new UniqueStepIds();
  const steps: CapabilityStep[] = [];

  // The run opened the application before its first decision, so the artifact has to as
  // well. Replay starts from wherever the surface happens to be, and a capability that
  // assumed it was already on the right screen would work exactly once.
  const opensItself = actions[0]?.type === 'navigate';
  if (!opensItself) {
    steps.push({
      id: ids.claim(`open-${slugSource(trace.application.name)}`),
      type: 'navigate',
      url: trace.application.entryPoint,
      risk: 'safe',
    });
  }

  for (const action of actions) {
    steps.push(toStep(action, ids.claim(stepIdFor(action)), trace.inputs));
  }

  const timestamp = options.now().toISOString();
  const draft: ArtifactDraft = {
    schemaVersion: '1',
    id: request.id,
    name: request.name,
    description: request.description,
    version: 1,
    application: {
      name: trace.application.name,
      entryPoint: trace.application.entryPoint,
    },
    inputs: inputDefinitions(trace, steps),
    outputs: outputDefinitions(steps, request),
    steps,
    successCondition: successConditionFor(trace),
    businessOutcomes: businessOutcomesFor(request),
    recoveries: [],
    metadata: {
      createdAt: timestamp,
      updatedAt: timestamp,
      tags: request.tags ?? [],
    },
  };

  return { draft, skippedActions: trace.entries.length - actions.length };
}

/**
 * The declared application states, taken from the request and never invented.
 *
 * A business outcome is a claim that the application says something specific in a
 * situation nobody exercised during discovery. Only the person recording the capability
 * knows which of its messages are answers, so the compiler carries theirs through and
 * guesses at none of its own.
 */
function businessOutcomesFor(request: CompilationRequest): BusinessOutcomeDefinition[] {
  return [...(request.businessOutcomes ?? [])];
}

/** Lower-case kebab-case, for building a step id out of a human label. */
function slugSource(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
