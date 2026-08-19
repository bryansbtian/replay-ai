import { describe, expect, it } from 'vitest';

import { DiscoveryEngine, type DiscoveryRequest } from '../../src/discovery/index.js';
import type {
  InterventionContext,
  InterventionHandler,
  InterventionOutcome,
  InterventionSettlement,
} from '../../src/execution/index.js';
import {
  RecordingEvidence,
  ScriptedLlm,
  silentLogger,
  testPolicy,
  TEST_TIMEOUTS,
} from '../discovery/support/fakes.js';
import { FakeSurface } from '../replay/support/fakeSurface.js';

/**
 * What discovery does with a handoff.
 *
 * Discovery resumes differently from replay, and the difference is the point of these
 * cases. There is no stored step whose condition could be re-checked, so what it does
 * instead is look again. The model is scripted, so none of this calls a provider.
 */

const ENTRY = 'https://demo.replay-ai.test/members';

const REQUEST: DiscoveryRequest = {
  goal: 'Look Up Demo Member 33333 And Read Their Savings Balance',
  target: { name: 'Demo Member Lookup', entryPoint: ENTRY },
};

const SEARCH_BUTTON = {
  description: 'Search Button',
  strategies: [{ kind: 'role', role: 'button', name: 'Search' }],
};

function action(body: Record<string, unknown>, summary = 'Do the next thing'): string {
  return JSON.stringify({ type: 'action', action: body, summary });
}

class ScriptedHandler implements InterventionHandler {
  readonly requests: InterventionContext[] = [];
  readonly settlements: InterventionSettlement[] = [];

  constructor(
    private readonly outcome: InterventionOutcome,
    private readonly onRequest?: () => void,
  ) {}

  request(context: InterventionContext): Promise<InterventionOutcome> {
    this.requests.push(context);
    this.onRequest?.();
    return Promise.resolve(this.outcome);
  }

  settle(settlement: InterventionSettlement): Promise<void> {
    this.settlements.push(settlement);
    return Promise.resolve();
  }
}

describe('a model that asks for a person', () => {
  it('pauses, then carries on from what the application shows afterwards', async () => {
    // A verification dialog is up, so the model escalates. A person clears it while the run
    // is paused, and the next decision is taken against the screen that is there now.
    let cleared = false;
    const handler = new ScriptedHandler({ status: 'resolved' }, () => {
      cleared = true;
    });

    const llm = new ScriptedLlm([
      JSON.stringify({
        type: 'escalate',
        reason: 'The application is asking for additional verification, which I should not do.',
      }),
      action({ type: 'click', target: SEARCH_BUTTON }, 'Continue now the dialog has gone'),
      JSON.stringify({
        type: 'complete',
        summary: 'The member summary is visible.',
        outputs: {},
      }),
    ]);

    const observed: string[] = [];
    const surface = new FakeSurface({
      url: ENTRY,
      observe: (): { textSummary: string } => {
        let text = 'Additional Verification Required';
        if (cleared) {
          text = 'Member Summary Ada Lovelace';
        }
        observed.push(text);
        return { textSummary: text };
      },
    });

    const engine = new DiscoveryEngine({
      surface,
      llm,
      policy: testPolicy(),
      evidence: new RecordingEvidence(),
      logger: silentLogger(),
      timeouts: TEST_TIMEOUTS,
      runId: '66666666-6666-4666-8666-666666666666',
      intervention: handler,
    });

    const result = await engine.discover(REQUEST);

    expect(handler.requests[0]).toMatchObject({
      source: 'discovery',
      reason: 'DISCOVERY_ESCALATION',
      code: 'DISCOVERY_ESCALATION_REQUESTED',
    });
    expect(handler.settlements).toEqual([{ resumed: true }]);

    // A run that needed help and got it is a run that succeeded, not one that is still
    // escalated.
    expect(result.status).toBe('success');

    // The decision after the handoff was taken against a screen observed after it, never
    // against the one the model was looking at when it escalated.
    const afterHandoff = observed.slice(observed.indexOf('Member Summary Ada Lovelace'));
    expect(afterHandoff.length).toBeGreaterThan(0);
    expect(llm.requests[1]?.instruction).toContain('Member Summary');
    expect(llm.requests[1]?.instruction).not.toContain('Additional Verification Required');
  });

  it('does not spend a step on the turn it escalated', async () => {
    let cleared = false;
    const handler = new ScriptedHandler({ status: 'resolved' }, () => {
      cleared = true;
    });
    const llm = new ScriptedLlm([
      JSON.stringify({ type: 'escalate', reason: 'I should not decide this.' }),
      action({ type: 'click', target: SEARCH_BUTTON }),
      JSON.stringify({ type: 'complete', summary: 'Done.', outputs: {} }),
    ]);
    const surface = new FakeSurface({
      url: ENTRY,
      observe: (): { textSummary: string } => {
        if (cleared) {
          return { textSummary: 'Member Summary' };
        }
        return { textSummary: 'Additional Verification Required' };
      },
    });

    const engine = new DiscoveryEngine({
      surface,
      llm,
      policy: testPolicy(),
      evidence: new RecordingEvidence(),
      logger: silentLogger(),
      timeouts: TEST_TIMEOUTS,
      runId: '66666666-6666-4666-8666-666666666666',
      intervention: handler,
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('success');
    // One carried-out action, which is the click. Asking for a person is not a step.
    expect(result.stepCount).toBe(1);
  });
});

describe('a model that asks for a person nobody answers', () => {
  it('returns the escalation it always returned', async () => {
    const handler = new ScriptedHandler({
      status: 'unavailable',
      reason: 'No operator took control.',
    });
    const llm = new ScriptedLlm([
      JSON.stringify({ type: 'escalate', reason: 'The application wants a permission decision.' }),
    ]);

    const engine = new DiscoveryEngine({
      surface: new FakeSurface({ url: ENTRY }),
      llm,
      policy: testPolicy(),
      evidence: new RecordingEvidence(),
      logger: silentLogger(),
      timeouts: TEST_TIMEOUTS,
      runId: '66666666-6666-4666-8666-666666666666',
      intervention: handler,
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('escalation');
    if (result.status !== 'escalation') {
      return;
    }
    expect(result.source).toBe('model');
    expect(handler.settlements[0]).toMatchObject({ resumed: false });
  });

  it('escalates as before when no handler is configured', async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({ type: 'escalate', reason: 'The application wants a permission decision.' }),
    ]);

    const engine = new DiscoveryEngine({
      surface: new FakeSurface({ url: ENTRY }),
      llm,
      policy: testPolicy(),
      evidence: new RecordingEvidence(),
      logger: silentLogger(),
      timeouts: TEST_TIMEOUTS,
      runId: '66666666-6666-4666-8666-666666666666',
    });

    expect((await engine.discover(REQUEST)).status).toBe('escalation');
  });
});
