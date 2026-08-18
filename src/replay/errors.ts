import { ReplayAiError } from '../errors.js';

/**
 * The typed carrier for a bad invocation.
 *
 * `validateInvocationInputs` throws this so that a caller validating on its own (a CLI
 * checking arguments, a future API endpoint) gets every problem in one typed object.
 * `ReplayEngine.run` catches it and reports it as a `ReplayFailure`, so the engine's own
 * contract stays uniform: one call, one result, no exception to remember to handle.
 */

/** One problem with an invocation, addressed by the input it concerns. */
export interface InvocationIssue {
  /** The declared input name, or the unexpected key that was supplied. */
  readonly name: string;
  readonly message: string;
}

function describeIssues(issues: readonly InvocationIssue[]): string {
  return issues.map((issue) => `  ${issue.name}: ${issue.message}`).join('\n');
}

/**
 * The invocation inputs do not match what the capability declares.
 *
 * The message names the offending inputs and says what was wrong with each, but never
 * echoes a supplied value: an invalid value can still be a secret, and an input may be
 * declared sensitive.
 */
export class InvocationInputError extends ReplayAiError {
  readonly capabilityId: string;
  readonly issues: readonly InvocationIssue[];

  constructor(capabilityId: string, issues: readonly InvocationIssue[]) {
    super(
      `Invocation inputs for capability "${capabilityId}" are invalid:\n${describeIssues(issues)}`,
      'REPLAY_INPUTS_INVALID',
    );
    this.capabilityId = capabilityId;
    this.issues = issues;
  }
}
