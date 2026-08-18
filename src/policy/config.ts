import { z } from 'zod';

import { CAPABILITY_STEP_TYPES, RISK_LEVELS } from '../artifacts/index.js';

/**
 * What this deployment permits, as data.
 *
 * The whole point of the file is that the answer to "may this run do that?" lives
 * outside the thing asking. A capability artifact is written by whoever recorded a
 * workflow; this is written by whoever operates it, and only the second is authoritative.
 *
 * Every list is closed and every default is the cautious one, so a missing setting can
 * only ever make the system refuse more, never less.
 */

/** What to do with an action of a given declared risk. */
export const RISK_DISPOSITIONS = ['allow', 'requireConfirmation', 'block'] as const;

export type RiskDisposition = (typeof RISK_DISPOSITIONS)[number];

/**
 * Schemes a URL may use.
 *
 * `https` alone by default. `http` is normal for a local development target and `file`
 * is what the offline fixture uses, and both are opt-in rather than assumed, which is
 * the same decision the domain allowlist makes: a deployment states what it needs.
 * `javascript:`, `data:`, and everything else are not expressible here at all.
 */
export const ALLOWED_SCHEME_VALUES = ['https', 'http', 'file'] as const;

export type AllowedScheme = (typeof ALLOWED_SCHEME_VALUES)[number];

const hostSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(255, 'must be at most 255 characters')
  // A host entry is a hostname with an optional port. No wildcards: `*.example.com`
  // reads as a small convenience and is how an allowlist ends up covering a subdomain
  // somebody else controls.
  .regex(
    /^[a-z0-9.-]+(?::\d{1,5})?$/i,
    'must be a hostname with an optional port, for example "localhost:3000"',
  );

const routeSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(255, 'must be at most 255 characters')
  .startsWith('/', 'must start with "/"');

export const policyConfigSchema = z.strictObject({
  /**
   * Hosts this deployment may reach. Empty means none, and a replay that navigates
   * anywhere is refused: an allowlist nobody filled in is not permission to go
   * everywhere.
   */
  allowedHosts: z.array(hostSchema).default([]),
  allowedSchemes: z.array(z.enum(ALLOWED_SCHEME_VALUES)).default(['https']),
  /**
   * Path prefixes, matched on segment boundaries. Empty means every path on an allowed
   * host, which is a deliberate exception to deny-by-default: the host is the control
   * that matters, and requiring every deployment to enumerate routes would push people
   * towards writing `/` and stopping thinking.
   *
   * A scheme with no host, such as `file`, has no such control, so for those the list is
   * required and an empty one refuses everything.
   */
  allowedRoutes: z.array(routeSchema).default([]),
  allowedActions: z.array(z.enum(CAPABILITY_STEP_TYPES)).default([...CAPABILITY_STEP_TYPES]),
  riskPolicy: z
    .strictObject({
      safe: z.enum(RISK_DISPOSITIONS).default('allow'),
      risky: z.enum(RISK_DISPOSITIONS).default('requireConfirmation'),
      irreversible: z.enum(RISK_DISPOSITIONS).default('block'),
    })
    .default({ safe: 'allow', risky: 'requireConfirmation', irreversible: 'block' }),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

/**
 * The policy a deployment gets when it says nothing: reach nothing, over https only,
 * ask before anything risky, never do anything irreversible.
 */
export const DEFAULT_POLICY: PolicyConfig = policyConfigSchema.parse({});

/** Risk levels as a value, so a summary can be written without restating them. */
export const POLICY_RISK_LEVELS = RISK_LEVELS;

/**
 * The policy in force, rendered for a log line or an evidence manifest.
 *
 * Nothing here is a secret, and an evidence record that does not say which rules applied
 * cannot answer whether an action should have been allowed.
 */
export type PolicySummary = {
  readonly allowedHosts: readonly string[];
  readonly allowedSchemes: readonly string[];
  readonly allowedRoutes: readonly string[];
  readonly allowedActions: readonly string[];
  readonly riskPolicy: Readonly<Record<string, string>>;
};

export function summarizePolicy(config: PolicyConfig): PolicySummary {
  return {
    allowedHosts: config.allowedHosts,
    allowedSchemes: config.allowedSchemes,
    allowedRoutes: config.allowedRoutes,
    allowedActions: config.allowedActions,
    riskPolicy: config.riskPolicy,
  };
}
