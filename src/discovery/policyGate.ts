import type { PolicyContext, PolicyDenied } from '../policy/index.js';

import type { AgentAction } from './AgentDecision.js';

/**
 * Where a model-proposed action becomes a question for the safety boundary.
 *
 * The engine that Phase 6 already wrote is the one that answers it. There is no
 * discovery-specific policy, no second allowlist, and no way for a decision to arrive at
 * the surface without having been through here first. A model claiming an action is safe
 * is a sentence in a summary; the deployment's configuration is the authority.
 */

/**
 * Identity for a run that has no capability yet.
 *
 * `PolicyContext` was written for a stored step, and its capability fields exist so a
 * decision can be attributed. A discovery run has nothing to attribute to yet, so it says
 * so: version zero is not a version any artifact can have, which is exactly the point.
 * Phase 8 is what turns a successful run into something with a real identity.
 */
const DISCOVERY_CAPABILITY_ID = 'discovery';
const DISCOVERY_CAPABILITY_VERSION = 0;

/**
 * Describes a proposed action to policy.
 *
 * The declared risk is derived from the action, never taken from the model. A model that
 * could label its own action would be a model that could argue itself past a guardrail,
 * and the two controls that matter for discovery do not depend on risk at all: the
 * deployment says which action types it permits and which destinations may be reached.
 *
 * `safe` matches what an artifact step of the same type declares by default, so an action
 * is judged the same way during discovery as it will be during replay.
 */
export function policyContextFor(action: AgentAction, step: number): PolicyContext {
  const base = {
    capabilityId: DISCOVERY_CAPABILITY_ID,
    capabilityVersion: DISCOVERY_CAPABILITY_VERSION,
    stepId: `step-${step}`,
    actionType: action.type,
    risk: 'safe',
  } as const;

  if (action.type === 'navigate') {
    return { ...base, url: action.url };
  }
  return base;
}

/** How a denial reads in a result or an evidence record. Already safe to record. */
export function describeDenial(decision: PolicyDenied): string {
  if (decision.detail === undefined) {
    return decision.reason;
  }
  return `${decision.reason} (${decision.detail})`;
}
