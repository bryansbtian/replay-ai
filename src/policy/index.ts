/**
 * The safety boundary: what this deployment permits, evaluated before anything happens.
 *
 * Nothing in this package performs an action, reads a file, or reaches a network. It is
 * given a description of a proposed action and returns a decision, which is what allows
 * replay to call it today and the discovery loop of a later phase to call the same
 * method for a model-proposed action without a second boundary being written.
 */
export {
  ALLOWED_SCHEME_VALUES,
  DEFAULT_POLICY,
  policyConfigSchema,
  RISK_DISPOSITIONS,
  summarizePolicy,
  type AllowedScheme,
  type PolicyConfig,
  type PolicySummary,
  type RiskDisposition,
} from './config.js';
export { StaticPolicyEngine } from './StaticPolicyEngine.js';
export {
  isAllowed,
  POLICY_DENIAL_CODES,
  type PolicyAllowed,
  type PolicyContext,
  type PolicyDecision,
  type PolicyDenialCode,
  type PolicyDenied,
  type PolicyEngine,
  type PolicyOutcome,
} from './types.js';
export { evaluateUrl, type UrlRejection, type UrlVerdict } from './url.js';
