import type { CapabilityStepType, RiskLevel } from '../artifacts/index.js';

/**
 * The vocabulary of the safety boundary.
 *
 * Everything an action must state about itself before it is allowed to happen, and
 * everything a decision says back. Deliberately free of any notion of *who* proposed the
 * action: a stored step and a future model-proposed action describe themselves the same
 * way, so both can be evaluated by the same engine without it learning about either.
 */

/**
 * What the policy engine is told about a proposed action.
 *
 * Notice what is absent. There is no target, no locator, no resolved value, and no
 * invocation input. No policy rule needs them, and a context that carried them would be
 * a copy of a password sitting in an audit record. If a future rule genuinely needs more,
 * it gets one named field rather than a bag.
 */
export interface PolicyContext {
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  /** The step or proposed action this decision is about. */
  readonly stepId: string;
  readonly actionType: CapabilityStepType;
  /**
   * What the capability says the action does. A description, never a permission: the
   * engine reads it to decide how careful to be, and an artifact claiming `safe` gains
   * nothing it would not have had by saying nothing.
   */
  readonly risk: RiskLevel;
  /** Present for an action that moves the surface, and for a redirect re-check. */
  readonly url?: string;
}

/**
 * Why an action was not allowed.
 *
 * Prefixed `POLICY_`, which is how a caller tells "the automation could not do this"
 * apart from "the automation was not permitted to do this". Those are different
 * incidents: one is a defect to fix, the other is the system working.
 */
export const POLICY_DENIAL_CODES = [
  /** The URL could not be parsed, so nothing about it could be checked. */
  'POLICY_URL_INVALID',
  /** The scheme is not one this deployment permits, such as `javascript:`. */
  'POLICY_SCHEME_NOT_ALLOWED',
  /** The host is not on the allowlist. */
  'POLICY_DOMAIN_NOT_ALLOWED',
  /** The host is allowed but the path is not. */
  'POLICY_ROUTE_NOT_ALLOWED',
  /** This deployment does not permit this kind of action at all. */
  'POLICY_ACTION_NOT_ALLOWED',
  /** The action needs an operator to approve it, and no operator is present. */
  'POLICY_RISK_CONFIRMATION_REQUIRED',
  /**
   * This deployment never performs an action at that declared risk automatically. By
   * default that is `irreversible`, and `detail` names the level, so the code stays
   * accurate for a deployment that also refuses `risky` outright.
   */
  'POLICY_RISK_BLOCKED',
] as const;

export type PolicyDenialCode = (typeof POLICY_DENIAL_CODES)[number];

/** The three things policy can say. `allow` is the only one that lets an action run. */
export type PolicyOutcome = 'allow' | 'block' | 'confirmationRequired';

export interface PolicyAllowed {
  readonly outcome: 'allow';
}

export interface PolicyDenied {
  /**
   * `block` means no. `confirmationRequired` means not without a person, which today
   * also means no, because there is no way to ask one. The two are kept apart because
   * they call for different responses: one is a rule to change, the other is a queue to
   * build.
   */
  readonly outcome: 'block' | 'confirmationRequired';
  readonly code: PolicyDenialCode;
  /** Title Case sentence, written to be read by whoever has to act on the denial. */
  readonly reason: string;
  /** The offending value, already safe to record. Absent when there is nothing to name. */
  readonly detail?: string;
}

/**
 * Structured rather than a boolean, because every caller needs to know why. A denial
 * that cannot explain itself becomes a support ticket.
 */
export type PolicyDecision = PolicyAllowed | PolicyDenied;

export function isAllowed(decision: PolicyDecision): decision is PolicyAllowed {
  return decision.outcome === 'allow';
}

/**
 * The safety boundary itself.
 *
 * One method, no state, no I/O. Replay calls it before every action; the discovery loop
 * of a later phase will call the same method with the same context for a model-proposed
 * action, which is what stops a second, weaker boundary from being written for it.
 */
export interface PolicyEngine {
  evaluate(context: PolicyContext): PolicyDecision;
}
