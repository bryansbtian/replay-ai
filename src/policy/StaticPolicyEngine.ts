import type { RiskLevel } from '../artifacts/index.js';

import type { PolicyConfig, RiskDisposition } from './config.js';
import type { PolicyContext, PolicyDecision, PolicyEngine } from './types.js';
import { evaluateUrl, type UrlRejection } from './url.js';

/**
 * Evaluates a proposed action against a fixed configuration.
 *
 * Pure and synchronous: the same context and the same configuration always produce the
 * same decision. That matters more here than anywhere else in the system, because a
 * safety boundary that can answer differently on two identical questions is not a
 * boundary, and because a rule this simple can be read in full by whoever has to trust
 * it.
 *
 * The checks run cheapest and broadest first. An action type this deployment does not
 * permit at all is refused before anyone parses a URL, and a risk the deployment refuses
 * outright is refused before anyone asks where it points.
 */

function denyUrl(rejection: UrlRejection, url: string): PolicyDecision {
  switch (rejection.kind) {
    case 'invalid':
      return {
        outcome: 'block',
        code: 'POLICY_URL_INVALID',
        reason: 'The Destination Is Not A Valid URL',
        detail: url,
      };
    case 'scheme':
      return {
        outcome: 'block',
        code: 'POLICY_SCHEME_NOT_ALLOWED',
        reason: 'This Deployment Does Not Permit That URL Scheme',
        detail: rejection.scheme,
      };
    case 'host':
      return {
        outcome: 'block',
        code: 'POLICY_DOMAIN_NOT_ALLOWED',
        reason: 'The Destination Host Is Not On The Allowlist',
        detail: rejection.host,
      };
    case 'route':
      return {
        outcome: 'block',
        code: 'POLICY_ROUTE_NOT_ALLOWED',
        reason: 'The Destination Path Is Not On The Allowlist',
        detail: rejection.path,
      };
  }
}

/**
 * Reads the disposition for a declared risk.
 *
 * An unrecognized level is refused rather than treated as `safe`. The only way to reach
 * that today is a hand-built context, because Phase 3 validates the field, but the point
 * of a deny-by-default engine is that an unrecognized value can never be the permissive
 * one.
 */
function dispositionFor(risk: RiskLevel, config: PolicyConfig): RiskDisposition | undefined {
  const disposition: RiskDisposition | undefined = config.riskPolicy[risk];
  return disposition;
}

export class StaticPolicyEngine implements PolicyEngine {
  private readonly config: PolicyConfig;

  constructor(config: PolicyConfig) {
    this.config = config;
  }

  evaluate(context: PolicyContext): PolicyDecision {
    const actionPermitted = this.config.allowedActions.some(
      (action) => action === context.actionType,
    );
    if (!actionPermitted) {
      return {
        outcome: 'block',
        code: 'POLICY_ACTION_NOT_ALLOWED',
        reason: 'This Deployment Does Not Permit That Action Type',
        detail: context.actionType,
      };
    }

    const riskDecision = this.evaluateRisk(context.risk);
    if (riskDecision !== undefined) {
      return riskDecision;
    }

    if (context.url === undefined) {
      return { outcome: 'allow' };
    }
    const verdict = evaluateUrl(context.url, this.config);
    if (verdict.ok) {
      return { outcome: 'allow' };
    }
    return denyUrl(verdict.rejection, context.url);
  }

  /** Returns a denial, or `undefined` when the declared risk is acceptable. */
  private evaluateRisk(risk: RiskLevel): PolicyDecision | undefined {
    const disposition = dispositionFor(risk, this.config);

    if (disposition === undefined) {
      return {
        outcome: 'block',
        code: 'POLICY_RISK_BLOCKED',
        reason: 'The Declared Risk Level Is Not One This Deployment Recognizes',
        detail: risk,
      };
    }
    if (disposition === 'allow') {
      return undefined;
    }
    if (disposition === 'requireConfirmation') {
      return {
        outcome: 'confirmationRequired',
        code: 'POLICY_RISK_CONFIRMATION_REQUIRED',
        reason: 'An Operator Must Approve An Action At This Risk Level',
        detail: risk,
      };
    }
    return {
      outcome: 'block',
      code: 'POLICY_RISK_BLOCKED',
      reason: 'This Deployment Never Performs An Action At This Risk Level Automatically',
      detail: risk,
    };
  }
}
