import type { CapabilityValue } from '../artifacts/index.js';

import type { ResolvedInputs, ResolvedInputValue } from './InputValidator.js';

/**
 * Turns a stored value reference into the string a `fill` step types.
 *
 * Two sources, and nothing else: a literal baked into the artifact, or the value of a
 * declared input. There is no expression evaluation, no template syntax, and no `eval`.
 * That is not a simplification to revisit later: a resolver that could compute would be
 * a decision made at replay time, which is exactly what deterministic replay excludes.
 */

/** A reference that names an input the invocation did not resolve. */
export interface UnresolvedParameter {
  readonly inputName: string;
}

export type ParameterResolution =
  | { readonly resolved: true; readonly value: string }
  | { readonly resolved: false; readonly unresolved: UnresolvedParameter };

/**
 * Renders a validated input for typing. Narrow by design: the argument is already one
 * of the three declared scalar types, so there is nothing here to guess about.
 */
function render(value: ResolvedInputValue): string {
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

export function resolveParameter(
  value: CapabilityValue,
  inputs: ResolvedInputs,
): ParameterResolution {
  if (value.source === 'literal') {
    return { resolved: true, value: value.value };
  }

  const supplied = inputs.get(value.name);
  if (supplied === undefined) {
    // Unreachable for a validated artifact and a validated invocation, because Phase 3
    // proves every reference names a declared input and the input validator resolves
    // every declared input. Reported rather than assumed, so a future value source
    // cannot turn this into a silent empty string.
    return { resolved: false, unresolved: { inputName: value.name } };
  }
  return { resolved: true, value: render(supplied) };
}
