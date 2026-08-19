import { describe, expect, it, vi } from 'vitest';

import { parseCapabilityArtifact, type CapabilityArtifact } from '../../src/artifacts/index.js';
import type {
  InterventionContext,
  InterventionHandler,
  InterventionOutcome,
  InterventionSettlement,
} from '../../src/execution/index.js';
import { StaticPolicyEngine } from '../../src/policy/index.js';
import { ReplayEngine } from '../../src/replay/index.js';
import { silentLogger } from '../discovery/support/fakes.js';
import { FakeSurface, type FakeBehavior } from '../replay/support/fakeSurface.js';
import { permissivePolicy } from '../replay/support/policy.js';

/**
 * What replay does with a handoff.
 *
 * The intervention handler is scripted here rather than being a real coordinator, because
 * what is under test is the engine's half of the contract: does it stop, does it check the
 * application before continuing, does it advance rather than repeat, and does it refuse to
 * carry on when a person did not actually fix anything.
 */

const ARTIFACT: CapabilityArtifact = parseCapabilityArtifact({
  schemaVersion: '1',
  id: 'lookup-member-balance',
  name: 'Lookup Member Balance',
  description: 'Looks up a member and reads their savings balance.',
  version: 1,
  application: { name: 'Demo Member Lookup', entryPoint: 'https://demo.replay-ai.test/members' },
  inputs: [
    {
      name: 'memberId',
      type: 'string',
      required: true,
      description: 'Member reference.',
      sensitive: false,
    },
  ],
  outputs: [
    { name: 'savingsBalance', type: 'string', description: 'Savings balance on the summary.' },
  ],
  steps: [
    {
      id: 'open-lookup',
      type: 'navigate',
      url: 'https://demo.replay-ai.test/members',
      risk: 'safe',
    },
    {
      id: 'enter-member-id',
      type: 'fill',
      target: {
        description: 'Member ID Field',
        strategies: [{ kind: 'label', text: 'Member ID' }],
      },
      value: { source: 'input', name: 'memberId' },
      risk: 'safe',
    },
    {
      id: 'click-search',
      type: 'click',
      target: {
        description: 'Search Button',
        strategies: [{ kind: 'role', role: 'button', name: 'Search' }],
      },
      risk: 'safe',
    },
    {
      id: 'await-member-summary',
      type: 'wait',
      condition: { type: 'textVisible', text: 'Member Summary' },
    },
    {
      id: 'read-savings-balance',
      type: 'extract',
      target: {
        description: 'Savings Balance',
        strategies: [{ kind: 'attribute', attribute: 'data-field', value: 'savings-balance' }],
      },
      output: 'savingsBalance',
    },
  ],
  successCondition: { type: 'textVisible', text: 'Member Summary' },
  metadata: { createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z' },
});

/** A handler that answers however the case needs, and remembers what it was asked. */
class ScriptedHandler implements InterventionHandler {
  readonly requests: InterventionContext[] = [];
  readonly settlements: InterventionSettlement[] = [];

  constructor(
    private readonly outcome: InterventionOutcome,
    private readonly onRequest?: () => void,
  ) {}

  request(context: InterventionContext): Promise<InterventionOutcome> {
    this.requests.push(context);
    // Stands in for the person: whatever the case says happened while the run was paused.
    this.onRequest?.();
    return Promise.resolve(this.outcome);
  }

  settle(settlement: InterventionSettlement): Promise<void> {
    this.settlements.push(settlement);
    return Promise.resolve();
  }
}

function engineWith(
  behavior: FakeBehavior,
  handler: InterventionHandler | undefined,
  policy = permissivePolicy(),
): { engine: ReplayEngine; surface: FakeSurface } {
  const surface = new FakeSurface({ url: 'https://demo.replay-ai.test/members', ...behavior });
  const engine = new ReplayEngine({
    surface,
    logger: silentLogger(),
    policy,
    replayId: '55555555-5555-4555-8555-555555555555',
    ...(handler !== undefined && { intervention: handler }),
  });
  return { engine, surface };
}

describe('a state the workflow cannot clear', () => {
  it('asks for a person, then continues when the state is finally there', async () => {
    // The wait fails while the interstitial is up, and passes once a person clears it.
    let cleared = false;
    const handler = new ScriptedHandler({ status: 'resolved' }, () => {
      cleared = true;
    });

    const { engine, surface } = engineWith(
      {
        waitFor: () => cleared,
        extract: () => '5234.17',
      },
      handler,
    );

    const result = await engine.run(ARTIFACT, { memberId: '33333' });

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(handler.requests[0]).toMatchObject({
      source: 'replay',
      reason: 'UNRECOVERABLE_FAILURE',
      subject: 'Lookup Member Balance',
      stepId: 'await-member-summary',
      code: 'REPLAY_WAIT_TIMEOUT',
    });
    expect(handler.settlements).toEqual([{ resumed: true }]);
    expect(result.outputs).toEqual({ savingsBalance: '5234.17' });
    // The workflow carried on from where it stopped rather than starting again.
    expect(surface.calls.filter((call) => call.method === 'navigate')).toHaveLength(1);
    expect(surface.calls.filter((call) => call.method === 'fill')).toHaveLength(1);
  });

  it('runs the failed step itself once a person has made it possible', async () => {
    let cleared = false;
    const handler = new ScriptedHandler({ status: 'resolved' }, () => {
      cleared = true;
    });
    const { engine } = engineWith({ waitFor: () => cleared, extract: () => '5234.17' }, handler);

    const result = await engine.run(ARTIFACT, { memberId: '33333' });

    // The step never happened: it failed, which is why somebody was called. So the engine
    // carries it out, and the second attempt is what proves the state was actually fixed.
    const step = result.completedSteps.find((one) => one.stepId === 'await-member-summary');
    expect(step).toMatchObject({ stepId: 'await-member-summary', attempts: 2 });
    expect(step?.resolvedByHuman).toBeUndefined();
  });

  it('does not repeat the action a person performed by hand', async () => {
    let cleared = false;
    const handler = new ScriptedHandler({ status: 'resolved' }, () => {
      cleared = true;
    });
    const { engine, surface } = engineWith(
      { waitFor: () => cleared, extract: () => '5234.17' },
      handler,
    );

    await engine.run(ARTIFACT, { memberId: '33333' });

    // Three: the wait that failed, the condition check after control came back, and the
    // capability's own success condition at the end. The wait step itself is never run a
    // second time, because re-running a step a person completed is how one submission
    // becomes two.
    expect(surface.calls.filter((call) => call.method === 'waitFor')).toHaveLength(3);
  });
});

describe('a person who did not resolve the state', () => {
  it('stops the run rather than carrying on regardless', async () => {
    // Control comes back, but the page is still wrong.
    const handler = new ScriptedHandler({ status: 'resolved' });
    const { engine, surface } = engineWith({ waitFor: () => false }, handler);

    const result = await engine.run(ARTIFACT, { memberId: '33333' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.stepId).toBe('await-member-summary');
    expect(result.code).toBe('REPLAY_WAIT_TIMEOUT');
    // Asked once, not once per attempt: a person who could not fix it is not asked again.
    expect(handler.requests).toHaveLength(1);
    // Nothing after the failed step ran.
    expect(surface.methods()).not.toContain('extract');
  });
});

describe('a run nobody can answer', () => {
  it('fails with a code that says nobody took it', async () => {
    const handler = new ScriptedHandler({
      status: 'unavailable',
      reason: 'No operator took control.',
    });
    const { engine } = engineWith({ waitFor: () => false }, handler);

    const result = await engine.run(ARTIFACT, { memberId: '33333' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_INTERVENTION_UNAVAILABLE');
  });

  it('fails as an abort when an operator ended it', async () => {
    const handler = new ScriptedHandler({ status: 'aborted', reason: 'An operator ended it.' });
    const { engine } = engineWith({ waitFor: () => false }, handler);

    const result = await engine.run(ARTIFACT, { memberId: '33333' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_INTERVENTION_ABORTED');
  });

  it('behaves exactly as before when no handler is configured', async () => {
    const { engine } = engineWith({ waitFor: () => false }, undefined);

    const result = await engine.run(ARTIFACT, { memberId: '33333' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    // A scheduled run with nobody watching gets the failure it always got.
    expect(result.code).toBe('REPLAY_WAIT_TIMEOUT');
  });
});

describe('policy and handoff', () => {
  /** Permits the workflow, and insists a person is present for anything declared risky. */
  function confirmationPolicy(): StaticPolicyEngine {
    return new StaticPolicyEngine({
      allowedHosts: ['demo.replay-ai.test'],
      allowedSchemes: ['https'],
      allowedRoutes: [],
      allowedActions: ['navigate', 'click', 'fill', 'extract', 'wait', 'checkpoint'],
      riskPolicy: { safe: 'allow', risky: 'requireConfirmation', irreversible: 'block' },
    });
  }

  /** The same workflow, with the submit declared risky the way a real one would be. */
  const RISKY_SUBMIT: CapabilityArtifact = parseCapabilityArtifact({
    ...ARTIFACT,
    steps: ARTIFACT.steps.map((step) => {
      if (step.id !== 'click-search') {
        return step;
      }
      return { ...step, risk: 'risky' };
    }),
  });

  it('asks for a person when the guardrail wants one, and continues after they act', async () => {
    const handler = new ScriptedHandler({ status: 'resolved' });
    const { engine } = engineWith(
      { waitFor: () => true, extract: () => '5234.17' },
      handler,
      confirmationPolicy(),
    );

    const result = await engine.run(RISKY_SUBMIT, { memberId: '12345' });

    expect(handler.requests[0]).toMatchObject({
      reason: 'POLICY_CONFIRMATION_REQUIRED',
      code: 'POLICY_RISK_CONFIRMATION_REQUIRED',
    });
    // The person performed the step; the capability's own success condition is what
    // proves the workflow got where it was meant to.
    expect(result.status).toBe('success');
  });

  it('never lets a handoff turn a blocked action into an allowed one', async () => {
    const blocking = new StaticPolicyEngine({
      allowedHosts: ['demo.replay-ai.test'],
      allowedSchemes: ['https'],
      allowedRoutes: [],
      // Filling is not permitted at all. That is a refusal, not a request for approval.
      allowedActions: ['navigate', 'extract', 'wait', 'checkpoint'],
      riskPolicy: { safe: 'allow', risky: 'block', irreversible: 'block' },
    });
    const handler = new ScriptedHandler({ status: 'resolved' });
    const { engine, surface } = engineWith({ waitFor: () => true }, handler, blocking);

    const result = await engine.run(ARTIFACT, { memberId: '12345' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.kind).toBe('policy');
    // Nobody was even asked: a denial that is not a confirmation request is the end of it.
    expect(handler.requests).toHaveLength(0);
    expect(surface.methods()).not.toContain('fill');
  });
});

describe('while a person holds the session', () => {
  it('the engine issues nothing', async () => {
    const acted = vi.fn();
    // The handler stands in for the whole pause: everything the engine would have done
    // next happens after `request` resolves, so anything it did during the pause would
    // have to appear before this call returns.
    const handler = new ScriptedHandler({ status: 'aborted', reason: 'stopped' }, acted);
    const { engine, surface } = engineWith({ waitFor: () => false }, handler);

    await engine.run(ARTIFACT, { memberId: '33333' });

    const duringPause = surface.calls.length;
    expect(acted).toHaveBeenCalledTimes(1);
    // Four calls: navigate, fill, click, and the wait that failed. Nothing after.
    expect(duringPause).toBe(4);
  });
});
