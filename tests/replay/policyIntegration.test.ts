import { describe, expect, it } from 'vitest';

import { ReplayEngine } from '../../src/replay/index.js';

import {
  artifact,
  fullArtifact,
  searchButtonTarget,
  silentLogger,
  TEST_TIMEOUTS,
  type JsonObject,
} from './support/artifacts.js';
import { FakeSurface } from './support/fakeSurface.js';
import { permissivePolicy, policyFrom } from './support/policy.js';

/**
 * The guardrail as replay experiences it.
 *
 * The property that matters most is negative and is asserted directly throughout: when
 * policy says no, the surface records no call at all. A boundary that stops a run after
 * the click has already happened is not a boundary.
 */

const LOCAL_DEMO = {
  allowedHosts: ['demo.replay-ai.test'],
  allowedSchemes: ['https' as const],
};

function engineWith(surface: FakeSurface, policy = permissivePolicy()): ReplayEngine {
  return new ReplayEngine({
    surface,
    logger: silentLogger(),
    policy,
    timeouts: TEST_TIMEOUTS,
    replayId: 'replay-under-test',
  });
}

function workingSurface(): FakeSurface {
  return new FakeSurface({ extract: () => '5234.17' });
}

/** A capability whose single step is a click at the given declared risk. */
function riskyClick(risk: string): JsonObject {
  return {
    inputs: [],
    outputs: [],
    steps: [{ id: 'submit-search', type: 'click', target: searchButtonTarget(), risk }],
  };
}

describe('policy runs before the surface', () => {
  it('lets a permitted run reach the surface as usual', async () => {
    const surface = workingSurface();

    const result = await engineWith(surface, policyFrom(LOCAL_DEMO)).run(fullArtifact(), {
      memberId: '12345',
    });

    expect(result.status).toBe('success');
    expect(surface.methods()).toContain('navigate');
  });

  it('never touches the surface when the destination is not allowed', async () => {
    const surface = workingSurface();
    const elsewhere = policyFrom({ allowedHosts: ['other.example'], allowedSchemes: ['https'] });

    const result = await engineWith(surface, elsewhere).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('POLICY_DOMAIN_NOT_ALLOWED');
    expect(result.kind).toBe('policy');
    expect(result.stepId).toBe('open-lookup');
    // The whole point: nothing happened.
    expect(surface.calls).toEqual([]);
  });

  it('never touches the surface when the action type is not allowed', async () => {
    const surface = workingSurface();
    const readOnly = policyFrom({
      ...LOCAL_DEMO,
      allowedActions: ['navigate', 'extract', 'wait', 'checkpoint'],
    });

    const result = await engineWith(surface, readOnly).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('POLICY_ACTION_NOT_ALLOWED');
    expect(result.stepId).toBe('enter-member-id');
    // Navigate and the opening checkpoint were permitted; the fill never happened.
    expect(surface.methods()).toEqual(['navigate', 'waitFor']);
    expect(surface.fills).toEqual([]);
  });

  it('stops a risky action and asks for an operator instead of performing it', async () => {
    const surface = workingSurface();
    const cautious = policyFrom(LOCAL_DEMO);

    const result = await engineWith(surface, cautious).run(artifact(riskyClick('risky')), {});

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('POLICY_RISK_CONFIRMATION_REQUIRED');
    expect(result.kind).toBe('policy');
    expect(result.message).toContain('An Operator Must Approve');
    expect(surface.calls).toEqual([]);
  });

  it('blocks an irreversible action outright', async () => {
    const surface = workingSurface();

    const result = await engineWith(surface, policyFrom(LOCAL_DEMO)).run(
      artifact(riskyClick('irreversible')),
      {},
    );

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('POLICY_RISK_BLOCKED');
    expect(surface.calls).toEqual([]);
  });
});

describe('an artifact cannot grant itself permission', () => {
  it('is refused when it calls a step safe and the deployment refuses that action type', async () => {
    const surface = workingSurface();
    const noClicking = policyFrom({
      ...LOCAL_DEMO,
      allowedActions: ['navigate', 'fill', 'extract', 'wait', 'checkpoint'],
    });

    const result = await engineWith(surface, noClicking).run(artifact(riskyClick('safe')), {});

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('POLICY_ACTION_NOT_ALLOWED');
    expect(surface.calls).toEqual([]);
  });

  it('is refused when it calls a step safe and the deployment refuses safe work too', async () => {
    // A deployment may be stricter than any artifact expects. The artifact's own opinion
    // of itself never widens what it may do.
    const surface = workingSurface();
    const frozen = policyFrom({
      ...LOCAL_DEMO,
      riskPolicy: { safe: 'block', risky: 'block', irreversible: 'block' } as const,
    });

    const result = await engineWith(surface, frozen).run(artifact(riskyClick('safe')), {});

    expect(result.status).toBe('failure');
    expect(surface.calls).toEqual([]);
  });
});

describe('a policy denial is not an application state', () => {
  it('is never reinterpreted as a business outcome', async () => {
    const surface = workingSurface();
    const withOutcome = fullArtifact({
      businessOutcomes: [
        {
          code: 'MEMBER_NOT_FOUND',
          description: 'No member exists for the supplied identifier.',
          condition: { type: 'textVisible', text: 'No Member Matches That Reference' },
        },
      ],
    });

    const result = await engineWith(
      surface,
      policyFrom({ allowedHosts: ['other.example'], allowedSchemes: ['https'] }),
    ).run(withOutcome, { memberId: '00000' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('POLICY_DOMAIN_NOT_ALLOWED');
    expect(surface.calls).toEqual([]);
  });

  it('is never cleared by a declared recovery', async () => {
    const surface = workingSurface();
    const withRecovery = fullArtifact({
      recoveries: [
        {
          code: 'KNOWN_SESSION_DIALOG',
          description: 'The console interrupts the search with a session warning.',
          condition: { type: 'textVisible', text: 'Session Warning' },
          action: { type: 'dismiss', target: searchButtonTarget() },
          maxAttempts: 2,
        },
      ],
    });

    const result = await engineWith(
      surface,
      policyFrom({ allowedHosts: ['other.example'], allowedSchemes: ['https'] }),
    ).run(withRecovery, { memberId: '12345' });

    expect(result.status).toBe('failure');
    expect(result.recoveries).toEqual([]);
    expect(surface.calls).toEqual([]);
  });
});

describe('a redirect off the allowlist', () => {
  it('stops the run once the surface reports where it actually landed', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      // The requested destination was permitted; the application answered elsewhere.
      url: 'https://random-site.example/login',
    });

    const result = await engineWith(surface, policyFrom(LOCAL_DEMO)).run(fullArtifact(), {
      memberId: '12345',
    });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('POLICY_DOMAIN_NOT_ALLOWED');
    expect(result.stepId).toBe('open-lookup');
    // The navigation happened, and nothing after it did.
    expect(surface.methods()).toEqual(['navigate']);
  });

  it('carries on when the surface lands somewhere still permitted', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      url: 'https://demo.replay-ai.test/members/list',
    });

    const result = await engineWith(surface, policyFrom(LOCAL_DEMO)).run(fullArtifact(), {
      memberId: '12345',
    });

    expect(result.status).toBe('success');
  });
});
