import type { CapabilityArtifact, CapabilityStep } from '../artifacts/index.js';
import {
  POLICY_DENIAL_CODES,
  type PolicyContext,
  type PolicyDecision,
  type PolicyDenied,
} from '../policy/index.js';

import { riskOf } from './RecoveryPlanner.js';
import type { StepFailure } from './StepExecutor.js';

/**
 * The one place a stored step becomes a question for the policy engine, and a denial
 * becomes something the run can report.
 *
 * Kept out of `StepExecutor` so that the mapping is testable on its own, and so that the
 * future discovery loop can build a `PolicyContext` for a model-proposed action without
 * copying the shape of one out of an executor.
 */

/**
 * Describes a step to policy, and nothing more.
 *
 * The target, the locator strategies, and the resolved value are all deliberately
 * absent. No rule needs them, and a policy context that carried a resolved value would
 * put a password into the audit trail of every action.
 *
 * A step with no declared risk is one that cannot change the application, so `safe` is a
 * fact about the step type rather than a default being assumed on the artifact's behalf.
 */
export function policyContextFor(
  artifact: CapabilityArtifact,
  step: CapabilityStep,
): PolicyContext {
  const base = {
    capabilityId: artifact.id,
    capabilityVersion: artifact.version,
    stepId: step.id,
    actionType: step.type,
    risk: riskOf(step) ?? 'safe',
  } as const;

  if (step.type === 'navigate') {
    return { ...base, url: step.url };
  }
  return base;
}

/**
 * Turns a denial into a step failure.
 *
 * `conditionFailed` stays false so that a denial never becomes an excuse to go looking
 * for a business outcome or a recovery. Policy said no; asking the page whether it meant
 * something friendlier would be the automation arguing with its own guardrail.
 */
export function toPolicyFailure(step: CapabilityStep, decision: PolicyDenied): StepFailure {
  return {
    code: decision.code,
    message: `Step "${step.id}" (${step.type}) was not permitted: ${decision.reason}`,
    expected: 'An Action This Deployment Permits',
    observed: decision.detail ?? decision.reason,
    conditionFailed: false,
  };
}

/** True when the decision is one that must stop the action. */
export function isDenied(decision: PolicyDecision): decision is PolicyDenied {
  return decision.outcome !== 'allow';
}

const DENIAL_CODES: ReadonlySet<string> = new Set(POLICY_DENIAL_CODES);

/**
 * Whether a step failed because the guardrail said no.
 *
 * The engine needs this to classify the run: a policy denial is not a defect to
 * investigate, and it must not be sent down the paths that ask the page what it meant or
 * try to clear an obstacle.
 */
export function isPolicyDenial(code: string): boolean {
  return DENIAL_CODES.has(code);
}
