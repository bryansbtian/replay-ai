import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY,
  policyConfigSchema,
  StaticPolicyEngine,
  summarizePolicy,
  type PolicyConfig,
  type PolicyContext,
  type PolicyDecision,
} from '../../src/policy/index.js';

/**
 * The safety boundary, evaluated on its own.
 *
 * Every case here is a rule someone has to trust, so each is stated as the question an
 * operator would ask: may this deployment go there, do that, at that risk?
 */

function configure(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return policyConfigSchema.parse(overrides);
}

function engine(overrides: Partial<PolicyConfig> = {}): StaticPolicyEngine {
  return new StaticPolicyEngine(configure(overrides));
}

function action(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    capabilityId: 'lookup-demo-member',
    capabilityVersion: 1,
    stepId: 'open-member-lookup',
    actionType: 'navigate',
    risk: 'safe',
    ...overrides,
  };
}

function decide(config: Partial<PolicyConfig>, context: Partial<PolicyContext>): PolicyDecision {
  return engine(config).evaluate(action(context));
}

const LOCAL = { allowedHosts: ['localhost'], allowedSchemes: ['http' as const] };

describe('policy configuration', () => {
  it('defaults to reaching nothing at all', () => {
    expect(DEFAULT_POLICY.allowedHosts).toEqual([]);
    expect(DEFAULT_POLICY.allowedRoutes).toEqual([]);
  });

  it('defaults to https only, so plain http is a deliberate choice', () => {
    expect(DEFAULT_POLICY.allowedSchemes).toEqual(['https']);
  });

  it('defaults to asking about risky work and refusing irreversible work', () => {
    expect(DEFAULT_POLICY.riskPolicy).toEqual({
      safe: 'allow',
      risky: 'requireConfirmation',
      irreversible: 'block',
    });
  });

  it('accepts a complete policy', () => {
    const parsed = configure({
      allowedHosts: ['localhost:3000', 'demo.replay-ai.test'],
      allowedSchemes: ['https', 'http'],
      allowedRoutes: ['/members', '/accounts'],
      allowedActions: ['navigate', 'extract'],
      riskPolicy: { safe: 'allow', risky: 'block', irreversible: 'block' },
    });

    expect(parsed.allowedActions).toEqual(['navigate', 'extract']);
  });

  it.each([
    ['a scheme it does not model', { allowedSchemes: ['ftp'] }],
    ['an action that is not a step type', { allowedActions: ['transfer'] }],
    ['a risk disposition it does not model', { riskPolicy: { safe: 'maybe' } }],
    ['a host with a path in it', { allowedHosts: ['localhost/members'] }],
    ['a route that is not a path', { allowedRoutes: ['members'] }],
    ['a key nobody declared', { allowUnsafe: true }],
  ])('refuses %s', (_name, malformed) => {
    expect(() => policyConfigSchema.parse(malformed)).toThrow();
  });

  it('summarizes what is in force without inventing anything', () => {
    const summary = summarizePolicy(configure({ allowedHosts: ['localhost'] }));

    expect(summary.allowedHosts).toEqual(['localhost']);
    expect(summary.riskPolicy['irreversible']).toBe('block');
  });
});

describe('the domain allowlist', () => {
  it('permits a host that was listed', () => {
    expect(decide(LOCAL, { url: 'http://localhost/members' }).outcome).toBe('allow');
  });

  it('refuses a host that was not', () => {
    const decision = decide(LOCAL, { url: 'http://random-site.example/members' });

    expect(decision.outcome).toBe('block');
    if (decision.outcome === 'allow') {
      return;
    }
    expect(decision.code).toBe('POLICY_DOMAIN_NOT_ALLOWED');
    expect(decision.detail).toBe('random-site.example');
  });

  it('refuses an empty allowlist rather than treating it as permission', () => {
    expect(
      decide({ allowedSchemes: ['https'] }, { url: 'https://anywhere.example/' }).outcome,
    ).toBe('block');
  });

  it('matches the host exactly, so a suffix is not a licence', () => {
    for (const url of [
      'http://localhost.attacker.example/members',
      'http://notlocalhost/members',
      'http://localhost.example.com/',
    ]) {
      expect(decide(LOCAL, { url }).outcome).toBe('block');
    }
  });

  it('ignores case and the trailing dot a resolver ignores too', () => {
    expect(decide(LOCAL, { url: 'http://LOCALHOST./members' }).outcome).toBe('allow');
  });

  it('treats a host entry without a port as any port on that host', () => {
    expect(decide(LOCAL, { url: 'http://localhost:3000/members' }).outcome).toBe('allow');
  });

  it('honours a port when the entry pins one', () => {
    const pinned = { allowedHosts: ['localhost:3000'], allowedSchemes: ['http' as const] };

    expect(decide(pinned, { url: 'http://localhost:3000/members' }).outcome).toBe('allow');
    expect(decide(pinned, { url: 'http://localhost:9999/members' }).outcome).toBe('block');
  });

  it('keeps loopback names distinct, because they are different strings', () => {
    expect(decide(LOCAL, { url: 'http://127.0.0.1/members' }).outcome).toBe('block');
    expect(decide(LOCAL, { url: 'http://[::1]/members' }).outcome).toBe('block');
  });
});

describe('URL safety', () => {
  it('refuses a URL it cannot parse', () => {
    const decision = decide(LOCAL, { url: 'not a url at all' });

    expect(decision.outcome).toBe('block');
    if (decision.outcome === 'allow') {
      return;
    }
    expect(decision.code).toBe('POLICY_URL_INVALID');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'file:///etc/passwd'])(
    'refuses the %s scheme when it was not permitted',
    (url) => {
      const decision = decide(LOCAL, { url });

      expect(decision.outcome).toBe('block');
      if (decision.outcome === 'allow') {
        return;
      }
      expect(decision.code).toBe('POLICY_SCHEME_NOT_ALLOWED');
    },
  );

  it('refuses a hostless scheme unless a route says which paths are reachable', () => {
    const decision = decide({ allowedSchemes: ['file'] }, { url: 'file:///etc/passwd' });

    expect(decision.outcome).toBe('block');
    if (decision.outcome === 'allow') {
      return;
    }
    expect(decision.code).toBe('POLICY_ROUTE_NOT_ALLOWED');
  });

  it('permits a hostless scheme under a declared route', () => {
    const config = { allowedSchemes: ['file' as const], allowedRoutes: ['/srv/fixtures'] };

    expect(decide(config, { url: 'file:///srv/fixtures/member.html' }).outcome).toBe('allow');
    expect(decide(config, { url: 'file:///etc/passwd' }).outcome).toBe('block');
  });
});

describe('route restrictions', () => {
  const routed = { ...LOCAL, allowedRoutes: ['/members', '/accounts/'] };

  it('permits a declared prefix and the paths beneath it', () => {
    expect(decide(routed, { url: 'http://localhost/members' }).outcome).toBe('allow');
    expect(decide(routed, { url: 'http://localhost/members/42' }).outcome).toBe('allow');
    expect(decide(routed, { url: 'http://localhost/accounts/1/detail' }).outcome).toBe('allow');
  });

  it('refuses a path outside every prefix', () => {
    const decision = decide(routed, { url: 'http://localhost/admin/users' });

    expect(decision.outcome).toBe('block');
    if (decision.outcome === 'allow') {
      return;
    }
    expect(decision.code).toBe('POLICY_ROUTE_NOT_ALLOWED');
    expect(decision.detail).toBe('/admin/users');
  });

  it('stops a prefix at a segment boundary', () => {
    expect(decide(routed, { url: 'http://localhost/membersecret' }).outcome).toBe('block');
  });

  it('permits every path on an allowed host when no route is declared', () => {
    expect(decide(LOCAL, { url: 'http://localhost/anything/at/all' }).outcome).toBe('allow');
  });
});

describe('the action allowlist', () => {
  it('permits an action that was listed', () => {
    const config = { ...LOCAL, allowedActions: ['navigate' as const, 'extract' as const] };

    expect(decide(config, { url: 'http://localhost/members' }).outcome).toBe('allow');
  });

  it('refuses an action that was not', () => {
    const config = { ...LOCAL, allowedActions: ['navigate' as const, 'extract' as const] };
    const decision = decide(config, { actionType: 'fill' });

    expect(decision.outcome).toBe('block');
    if (decision.outcome === 'allow') {
      return;
    }
    expect(decision.code).toBe('POLICY_ACTION_NOT_ALLOWED');
    expect(decision.detail).toBe('fill');
  });

  it('refuses an action nobody has heard of', () => {
    // Reachable from a future caller that proposes an action rather than replaying one.
    const unknown = { ...action(), actionType: 'transfer' } as unknown as PolicyContext;

    expect(engine(LOCAL).evaluate(unknown).outcome).toBe('block');
  });

  it('refuses an action before it looks at where the action points', () => {
    // A refused action type is refused even when the destination would have been fine.
    const config = { ...LOCAL, allowedActions: ['extract' as const] };
    const decision = decide(config, { url: 'http://localhost/members' });

    expect(decision.outcome).toBe('block');
    if (decision.outcome === 'allow') {
      return;
    }
    expect(decision.code).toBe('POLICY_ACTION_NOT_ALLOWED');
  });
});

describe('risk classification', () => {
  it('allows a safe action', () => {
    expect(decide(LOCAL, { risk: 'safe', url: 'http://localhost/x' }).outcome).toBe('allow');
  });

  it('asks for an operator before a risky action, and does not perform it', () => {
    const decision = decide(LOCAL, { risk: 'risky', actionType: 'click' });

    expect(decision.outcome).toBe('confirmationRequired');
    if (decision.outcome === 'allow') {
      return;
    }
    expect(decision.code).toBe('POLICY_RISK_CONFIRMATION_REQUIRED');
  });

  it('refuses an irreversible action outright', () => {
    const decision = decide(LOCAL, { risk: 'irreversible', actionType: 'click' });

    expect(decision.outcome).toBe('block');
    if (decision.outcome === 'allow') {
      return;
    }
    expect(decision.code).toBe('POLICY_RISK_BLOCKED');
    expect(decision.detail).toBe('irreversible');
  });

  it('refuses a risk level it does not recognize', () => {
    const unknown = { ...action(), risk: 'probably-fine' } as unknown as PolicyContext;

    expect(engine(LOCAL).evaluate(unknown).outcome).toBe('block');
  });

  it('lets a deployment refuse risky work outright', () => {
    const strict = {
      ...LOCAL,
      riskPolicy: { safe: 'allow', risky: 'block', irreversible: 'block' } as const,
    };
    const decision = decide(strict, { risk: 'risky', actionType: 'click' });

    expect(decision.outcome).toBe('block');
    if (decision.outcome === 'allow') {
      return;
    }
    // The code names the level rather than assuming only irreversible work is refused.
    expect(decision.detail).toBe('risky');
  });

  it('lets a deployment permit risky work, which is a decision it makes and not the artifact', () => {
    const permissive = {
      ...LOCAL,
      riskPolicy: { safe: 'allow', risky: 'allow', irreversible: 'block' } as const,
    };

    expect(decide(permissive, { risk: 'risky', actionType: 'click' }).outcome).toBe('allow');
  });
});

describe('what the policy engine is told', () => {
  it('is given no target, no locator, and no value to leak', () => {
    const context = action({ url: 'http://localhost/members' });

    expect(Object.keys(context).sort()).toEqual([
      'actionType',
      'capabilityId',
      'capabilityVersion',
      'risk',
      'stepId',
      'url',
    ]);
  });

  it('is pure: the same question always gets the same answer', () => {
    const subject = engine(LOCAL);
    const context = action({ url: 'http://random-site.example/' });

    expect(subject.evaluate(context)).toEqual(subject.evaluate(context));
  });
});
