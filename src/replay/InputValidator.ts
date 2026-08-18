import type { CapabilityArtifact, InputDefinition, ValueType } from '../artifacts/index.js';

import { InvocationInputError, type InvocationIssue } from './errors.js';

/**
 * Checks an invocation against the capability's declared inputs, before anything
 * touches the application.
 *
 * Three decisions, each deliberate:
 *
 * 1. **Unknown keys are rejected.** A key nobody declared is a caller who thinks this
 *    capability does something it does not, and ignoring it turns that into a silently
 *    wrong run. Rejecting costs one clear error message; ignoring costs a debugging
 *    session.
 * 2. **No coercion.** `12345` is not a valid `string` input and `"12345"` is not a valid
 *    `number` input. The artifact states the type it wants, so a caller that guesses
 *    wrong finds out here rather than through whatever the application does with it.
 * 3. **An omitted optional input fills as the empty string.** The only consumer of an
 *    input is a `fill` step, and clearing a field is exactly what "no value supplied"
 *    means for a form. Phase 3 has no default-value model, so the alternative would be
 *    to fail, which would make `required: false` unusable.
 *
 * Every problem is reported at once, so a bad invocation takes one round trip to fix.
 */

/** An invocation value that has passed validation: a scalar the artifact asked for. */
export type ResolvedInputValue = string | number | boolean;

/** Declared input names mapped to the value replay will use for them. */
export type ResolvedInputs = ReadonlyMap<string, ResolvedInputValue>;

export type InvocationInputs = Readonly<Record<string, unknown>>;

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}

/** True when the value is exactly the declared scalar type, with no coercion. */
function matchesType(value: unknown, type: ValueType): boolean {
  if (type === 'string') {
    return typeof value === 'string';
  }
  if (type === 'boolean') {
    return typeof value === 'boolean';
  }
  // A NaN or an infinity would pass `typeof` and then fill a field with "NaN", which is
  // not something any workflow means to type.
  return typeof value === 'number' && Number.isFinite(value);
}

function unknownInputIssues(
  supplied: InvocationInputs,
  declared: readonly InputDefinition[],
): InvocationIssue[] {
  const declaredNames = new Set(declared.map((input) => input.name));
  const issues: InvocationIssue[] = [];
  for (const name of Object.keys(supplied)) {
    if (declaredNames.has(name)) {
      continue;
    }
    issues.push({ name, message: 'is not an input of this capability' });
  }
  return issues;
}

function readInput(
  input: InputDefinition,
  supplied: InvocationInputs,
): { value?: ResolvedInputValue; issue?: InvocationIssue } {
  const raw = supplied[input.name];

  if (raw === undefined) {
    if (input.required) {
      return { issue: { name: input.name, message: `is required and must be a ${input.type}` } };
    }
    // Documented above: an optional input nobody supplied clears the field it fills.
    return { value: '' };
  }

  if (!matchesType(raw, input.type)) {
    return {
      issue: {
        name: input.name,
        message: `must be a ${input.type}, received ${describeType(raw)}`,
      },
    };
  }

  return { value: raw as ResolvedInputValue };
}

/**
 * Validates the invocation and returns the values replay will use.
 *
 * @throws InvocationInputError listing every problem found.
 */
export function validateInvocationInputs(
  artifact: CapabilityArtifact,
  supplied: InvocationInputs,
): ResolvedInputs {
  const issues: InvocationIssue[] = unknownInputIssues(supplied, artifact.inputs);
  const resolved = new Map<string, ResolvedInputValue>();

  for (const input of artifact.inputs) {
    const outcome = readInput(input, supplied);
    if (outcome.issue !== undefined) {
      issues.push(outcome.issue);
      continue;
    }
    if (outcome.value !== undefined) {
      resolved.set(input.name, outcome.value);
    }
  }

  if (issues.length > 0) {
    throw new InvocationInputError(artifact.id, issues);
  }
  return resolved;
}
