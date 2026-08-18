import {
  policyConfigSchema,
  StaticPolicyEngine,
  type PolicyConfig,
  type PolicyEngine,
} from '../../../src/policy/index.js';

/**
 * Policy plumbing for the replay suites.
 *
 * Most of them are about the engine rather than about the guardrail, so they run under a
 * policy that permits what the demo capability does. It is written out rather than
 * bypassed: a test that constructed an engine with no boundary at all would be testing a
 * configuration that cannot exist in the product.
 */

export function policyFrom(overrides: Partial<PolicyConfig> = {}): PolicyEngine {
  return new StaticPolicyEngine(policyConfigSchema.parse(overrides));
}

/**
 * Permits everything the fixtures need: the demo host, the local file the browser suites
 * drive, and every action at every risk level.
 */
export function permissivePolicy(): PolicyEngine {
  return policyFrom({
    allowedHosts: ['demo.replay-ai.test', 'localhost', '127.0.0.1'],
    allowedSchemes: ['https', 'http', 'file'],
    allowedRoutes: ['/'],
    riskPolicy: { safe: 'allow', risky: 'allow', irreversible: 'allow' },
  });
}
