import type { BusinessOutcomeDefinition } from '../artifacts/index.js';

/**
 * What the compiler needs that the trace cannot supply.
 *
 * Deliberately short. Everything derivable from the run is derived: the steps, the
 * targets, the inputs, the outputs, the application, and the success condition all come
 * out of what actually happened. What is left is the part a run genuinely does not know,
 * which is what this capability should be called and what it is for.
 *
 * Descriptions are asked for rather than generated because an artifact is chosen from a
 * list by a person or an agent, and "Value read from the application as savingsBalance" is
 * a placeholder, not a description. The compiler falls back to one rather than refusing,
 * so the flow works before anybody has written the prose.
 */

/** A description and nothing else. The name and type come from the run. */
export interface OutputDescription {
  /** Must match the name an extract action used during discovery. */
  readonly name: string;
  readonly description: string;
}

export interface CompilationRequest {
  /** Machine identifier, and the file name in the store. Lower-case kebab-case. */
  readonly id: string;
  /** Human-facing name, in Title Case, for example "Lookup Member Balance". */
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
  /** Prose for the values the run extracted, keyed by the name the run used. */
  readonly outputs?: readonly OutputDescription[];
  /**
   * Application states this capability should recognize.
   *
   * Supplied rather than inferred. Only the person recording the capability knows which of
   * an application's messages are answers to the question and which are failures, and a
   * compiler that guessed would be classifying by matching page text, which is the one
   * thing a stable code must never come from.
   */
  readonly businessOutcomes?: readonly BusinessOutcomeDefinition[];
  /**
   * Replace a capability that already exists under this id.
   *
   * Off by default. Overwriting is how a working capability is silently replaced by one
   * that merely compiled, so it has to be asked for.
   */
  readonly overwrite?: boolean;
}
