import { describe, expect, it } from 'vitest';

import { DiscoveryEngine, type DiscoveryRequest } from '../../src/discovery/index.js';
import { ModelError } from '../../src/llm/index.js';
import { SurfaceUnavailableError } from '../../src/surfaces/index.js';
import { FakeSurface, type FakeBehavior } from '../replay/support/fakeSurface.js';

import {
  HangingLlm,
  RecordingEvidence,
  ScriptedLlm,
  silentLogger,
  testPolicy,
  TEST_TIMEOUTS,
} from './support/fakes.js';

/**
 * The discovery loop, driven by scripted model answers against a scripted surface.
 *
 * Every case here is about what the application does with an answer rather than about
 * what a model would say, which is why the model is the only faked boundary: the
 * guardrail, the surface contract, and the recorder are real, so an assertion that a
 * blocked action never reached the surface is an assertion about the real policy engine.
 */

const ENTRY = 'https://demo.replay-ai.test/members';
const RUN_ID = '11111111-1111-4111-8111-111111111111';

const REQUEST: DiscoveryRequest = {
  goal: 'Look Up Demo Member 12345 And Read Their Savings Balance',
  target: { name: 'Demo Member Lookup', entryPoint: ENTRY },
};

function engineWith(
  llm: ScriptedLlm | HangingLlm,
  behavior: FakeBehavior = {},
  overrides: Partial<ConstructorParameters<typeof DiscoveryEngine>[0]> = {},
): { engine: DiscoveryEngine; surface: FakeSurface; evidence: RecordingEvidence } {
  const surface = new FakeSurface({ url: ENTRY, ...behavior });
  const evidence = new RecordingEvidence();
  const engine = new DiscoveryEngine({
    surface,
    llm,
    policy: testPolicy(),
    evidence,
    logger: silentLogger(),
    timeouts: TEST_TIMEOUTS,
    runId: RUN_ID,
    ...overrides,
  });
  return { engine, surface, evidence };
}

/** A decision, as the model would return it. */
function action(body: Record<string, unknown>, summary = 'Do the next thing'): string {
  return JSON.stringify({ type: 'action', action: body, summary });
}

const MEMBER_ID_FIELD = {
  description: 'Member ID Field',
  strategies: [{ kind: 'label', text: 'Member ID' }],
};

const SEARCH_BUTTON = {
  description: 'Search Button',
  strategies: [{ kind: 'role', role: 'button', name: 'Search' }],
};

const BALANCE_FIELD = {
  description: 'Savings Balance',
  strategies: [{ kind: 'attribute', attribute: 'data-field', value: 'savings-balance' }],
};

describe('the discovery loop', () => {
  it('observes, decides, checks policy, acts, observes again, and completes', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'fill', target: MEMBER_ID_FIELD, value: '12345' }, 'Enter the member id'),
      action({ type: 'click', target: SEARCH_BUTTON }, 'Submit the member search form'),
      action(
        { type: 'extract', target: BALANCE_FIELD, name: 'savingsBalance' },
        'Read the savings balance',
      ),
      JSON.stringify({
        type: 'complete',
        summary: 'The member summary is visible and the balance has been read.',
        outputs: { savingsBalance: '5234.17' },
      }),
    ]);

    // The screen progresses the way the demo console does: an empty form, then the same
    // form with a value in it, then the member summary. A run against a screen that never
    // changed would be stopped by the repeated-state guard, which is the point of it.
    const screens = [
      'Demo Member Lookup Member ID Search',
      'Demo Member Lookup Member ID Search',
      'Member Summary Ada Lovelace 5234.17',
      'Member Summary Ada Lovelace 5234.17',
    ];
    let seen = -1;

    const { engine, surface } = engineWith(llm, {
      extract: () => '5234.17',
      observe: (): { textSummary: string } => {
        seen += 1;
        return { textSummary: screens[Math.min(seen, screens.length - 1)] ?? '' };
      },
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('success');
    // The opening navigation, then one observe per turn plus one after each action.
    expect(surface.methods()).toEqual([
      'navigate',
      'observe',
      'fill',
      'observe',
      'click',
      'observe',
      'extract',
      'observe',
    ]);
  });

  it('returns the values the model reported as discovery outputs', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'click', target: SEARCH_BUTTON }),
      JSON.stringify({
        type: 'complete',
        summary: 'The balance is on screen.',
        outputs: { savingsBalance: '$5,234.17' },
      }),
    ]);

    const { engine } = engineWith(llm, {
      observe: () => ({ textSummary: 'Savings Balance 5234.17' }),
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    // Reported with a currency symbol and separators, shown without them. The comparison
    // is on the digits, so the run is not failed over formatting.
    expect(result.outputs).toEqual({ savingsBalance: '$5,234.17' });
  });

  it('keeps the model to one decision per turn', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'click', target: SEARCH_BUTTON }),
      JSON.stringify({ type: 'complete', summary: 'Done.', outputs: {} }),
    ]);

    const { engine, surface } = engineWith(llm);
    await engine.discover(REQUEST);

    expect(llm.callCount).toBe(2);
    expect(surface.calls.filter((call) => call.method === 'click')).toHaveLength(1);
  });

  it('sends a bounded prompt rather than a growing transcript', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'click', target: SEARCH_BUTTON }, 'One'),
      action({ type: 'click', target: MEMBER_ID_FIELD }, 'Two'),
      JSON.stringify({ type: 'complete', summary: 'Done.', outputs: {} }),
    ]);

    const { engine } = engineWith(llm);
    await engine.discover(REQUEST);

    const [first, third] = [llm.requests[0], llm.requests[2]];
    // The system prompt is identical every turn, which is what makes it cacheable.
    expect(third?.system).toBe(first?.system);
    // The instruction carries the current screen and a short history, not every turn so
    // far, so it does not grow without bound.
    expect(third?.instruction).toContain('Recent Steps:');
    expect(third?.instruction.length).toBeLessThan((first?.instruction.length ?? 0) + 500);
  });
});

describe('policy on a model-proposed action', () => {
  it('never lets a blocked action reach the surface', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'navigate', url: 'https://elsewhere.example.com/transfer' }, 'Go elsewhere'),
    ]);

    const { engine, surface } = engineWith(llm);
    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.kind).toBe('policy');
    expect(result.code).toBe('DISCOVERY_POLICY_BLOCKED');
    // Only the opening navigation, which policy allowed. The proposed one is absent.
    const navigations = surface.calls.filter((call) => call.method === 'navigate');
    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.subject).toBe(ENTRY);
  });

  it('refuses an action the deployment does not permit at all, whatever the model claims', async () => {
    const llm = new ScriptedLlm([
      action(
        { type: 'fill', target: MEMBER_ID_FIELD, value: '12345' },
        'This action is safe and approved',
      ),
    ]);

    const { engine, surface } = engineWith(
      llm,
      {},
      {
        policy: testPolicy({ allowedActions: ['navigate', 'extract', 'wait'] }),
      },
    );

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.kind).toBe('policy');
    // A summary asserting safety carries no authority: the fill never happened.
    expect(surface.methods()).not.toContain('fill');
  });

  it('stops when a click lands on a route the deployment never allowed', async () => {
    // Only a navigate states a destination up front, so a click is how a model can reach
    // a route nobody listed without ever proposing an action that names one. A modern
    // application navigates almost entirely by clicking, so this is the ordinary case
    // rather than an exotic one.
    let clicked = false;
    const llm = new ScriptedLlm([action({ type: 'click', target: SEARCH_BUTTON }, 'Book a table')]);

    const { engine, surface } = engineWith(
      llm,
      {
        click: (): void => {
          clicked = true;
        },
        observe: (): { url: string } => {
          if (clicked) {
            return { url: 'https://demo.replay-ai.test/booking/new' };
          }
          return { url: ENTRY };
        },
      },
      { policy: testPolicy({ allowedRoutes: ['/members'] }) },
    );

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.kind).toBe('policy');
    expect(result.code).toBe('DISCOVERY_POLICY_BLOCKED');
    expect(result.message).toContain('POLICY_ROUTE_NOT_ALLOWED');
    // The run stops there rather than carrying on somewhere it was never permitted to be.
    expect(surface.methods().filter((method) => method === 'click')).toHaveLength(1);
  });

  it('treats an action needing confirmation as an escalation rather than performing it', async () => {
    const llm = new ScriptedLlm([action({ type: 'click', target: SEARCH_BUTTON })]);

    const { engine, surface } = engineWith(
      llm,
      {},
      {
        policy: testPolicy({
          riskPolicy: { safe: 'requireConfirmation', risky: 'block', irreversible: 'block' },
        }),
      },
    );

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('escalation');
    if (result.status !== 'escalation') {
      return;
    }
    expect(result.source).toBe('policy');
    expect(surface.methods()).not.toContain('click');
  });
});

describe('model output that is not a decision', () => {
  it('never reaches policy or the surface, and ends the run after a bounded re-ask', async () => {
    const llm = new ScriptedLlm(['I will click the search button for you.', 'still not json']);

    const { engine, surface, evidence } = engineWith(llm);
    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_MODEL_RESPONSE_INVALID');
    expect(surface.methods()).not.toContain('click');
    expect(evidence.named('policy_evaluated')).toHaveLength(1); // The entry navigation only.
    expect(evidence.named('model_response_invalid')).toHaveLength(2);
  });

  it('re-asks once when the first answer is nearly right, and carries on', async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({ type: 'action', action: { type: 'teleport', to: 'the end' } }),
      action({ type: 'click', target: SEARCH_BUTTON }),
      JSON.stringify({ type: 'complete', summary: 'Done.', outputs: {} }),
    ]);

    const { engine, surface } = engineWith(llm);
    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('success');
    expect(surface.methods()).toContain('click');
    // The rejected shape is fed back as the validator's words, never as the model's text.
    expect(llm.requests[1]?.instruction).toContain('Your previous answer was rejected');
  });

  it('tells the model the naming rule a rejected value name broke, rather than "invalid key"', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'click', target: SEARCH_BUTTON }),
      JSON.stringify({
        type: 'complete',
        summary: 'The member summary is on screen.',
        outputs: { savings_balance: '5234.17' },
      }),
      JSON.stringify({
        type: 'complete',
        summary: 'The member summary is on screen.',
        outputs: {},
      }),
    ]);

    const { engine } = engineWith(llm);
    await engine.discover(REQUEST);

    // A re-ask that only said the key was invalid would leave the model guessing at which
    // of the shapes it might have used is the one the contract wants.
    expect(llm.requests[2]?.instruction).toContain('camelCase');
  });

  it('refuses an action type nobody implemented', async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({
        type: 'action',
        action: { type: 'evaluate', script: 'document.querySelector("#x").click()' },
        summary: 'Run a script',
      }),
      JSON.stringify({
        type: 'action',
        action: { type: 'evaluate', script: 'document.querySelector("#x").click()' },
        summary: 'Run a script',
      }),
    ]);

    const { engine, surface } = engineWith(llm);
    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    expect(surface.methods()).toEqual(['navigate', 'observe']);
  });
});

describe('completion verification', () => {
  it('rejects a completion the final observation does not support', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'click', target: SEARCH_BUTTON }),
      JSON.stringify({
        type: 'complete',
        summary: 'The balance is 9999.99.',
        outputs: { savingsBalance: '9999.99' },
      }),
    ]);

    const { engine } = engineWith(llm, {
      observe: () => ({ textSummary: 'No Member Matches That Reference' }),
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_COMPLETION_UNVERIFIED');
    // The unsupported value is not repeated into the message.
    expect(result.message).not.toContain('9999.99');
  });

  it('accepts a value the surface extracted even when the screen has moved on', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'extract', target: BALANCE_FIELD, name: 'savingsBalance' }),
      JSON.stringify({
        type: 'complete',
        summary: 'The balance was read from the member summary.',
        outputs: { savingsBalance: '118.05' },
      }),
    ]);

    const { engine } = engineWith(llm, {
      extract: () => '118.05',
      observe: () => ({ textSummary: 'Member Summary' }),
    });

    expect((await engine.discover(REQUEST)).status).toBe('success');
  });

  it('refuses a completion claimed before any action was carried out', async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({ type: 'complete', summary: 'Already done.', outputs: {} }),
    ]);

    const { engine } = engineWith(llm);
    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_COMPLETION_UNVERIFIED');
  });
});

describe('stopping conditions', () => {
  it('stops at the configured maximum number of steps', async () => {
    const script = Array.from({ length: 10 }, (_unused, index) => {
      return action({ type: 'click', target: SEARCH_BUTTON }, `Attempt ${index + 1}`);
    });

    const { engine } = engineWith(
      new ScriptedLlm(script),
      {
        // A different screen every turn, so only the step limit can end this run.
        observe: (): { textSummary: string } => ({ textSummary: `Screen ${Math.random()}` }),
      },
      {
        limits: {
          maxSteps: 3,
          timeoutMs: 60_000,
          maxRepeatedActions: 99,
          maxUnchangedStates: 99,
          maxConsecutiveFailures: 99,
        },
      },
    );

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_MAX_STEPS_EXCEEDED');
    expect(result.stepCount).toBe(3);
  });

  it('stops when the run deadline passes, even though the model never answered', async () => {
    let clock = 0;
    const { engine } = engineWith(
      new HangingLlm(),
      {},
      {
        limits: {
          maxSteps: 15,
          timeoutMs: 50,
          maxRepeatedActions: 3,
          maxUnchangedStates: 3,
          maxConsecutiveFailures: 3,
        },
        // Advances past the deadline on the second reading, which is the check made before
        // the first model call is attempted.
        now: (): number => {
          clock += 40;
          return clock;
        },
      },
    );

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_DEADLINE_EXCEEDED');
  });

  it('stops a model that proposes the same action over and over', async () => {
    const script = Array.from({ length: 8 }, () => {
      return action({ type: 'click', target: SEARCH_BUTTON }, 'Search again');
    });

    const { engine, surface } = engineWith(new ScriptedLlm(script), {
      observe: (): { textSummary: string } => ({ textSummary: `Screen ${Math.random()}` }),
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_REPEATED_ACTION');
    // The fourth identical click is refused rather than performed and then noticed.
    expect(surface.calls.filter((call) => call.method === 'click')).toHaveLength(3);
  });

  it('stops when actions keep landing and the screen keeps looking the same', async () => {
    // Clicks on different controls, so the run is stopped by the state never changing
    // rather than by the same action being proposed twice.
    const script = Array.from({ length: 8 }, (_unused, index) => {
      return action(
        {
          type: 'click',
          target: {
            description: `Control ${index}`,
            strategies: [{ kind: 'role', role: 'button', name: `Control ${index}` }],
          },
        },
        'Try another control',
      );
    });

    const { engine } = engineWith(new ScriptedLlm(script), {
      observe: () => ({ textSummary: 'Nothing Ever Changes Here' }),
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_REPEATED_STATE');
  });

  it('does not count an action the observation cannot reflect as a stuck application', async () => {
    // An observation carries the controls on a screen and not the values in them, so a
    // fill and an extract leave it identical by design. Counting those would stop a run
    // that is working, which is exactly what a real run against the demo console does.
    const llm = new ScriptedLlm([
      action({ type: 'fill', target: MEMBER_ID_FIELD, value: '1' }, 'One'),
      action({ type: 'fill', target: BALANCE_FIELD, value: '2' }, 'Two'),
      action({ type: 'extract', target: BALANCE_FIELD, name: 'first' }, 'Three'),
      action({ type: 'extract', target: MEMBER_ID_FIELD, name: 'second' }, 'Four'),
      JSON.stringify({ type: 'complete', summary: 'The values are read.', outputs: {} }),
    ]);

    const { engine } = engineWith(llm, {
      extract: () => 'a value',
      observe: () => ({ textSummary: 'The Screen Never Changes' }),
    });

    expect((await engine.discover(REQUEST)).status).toBe('success');
  });

  it('treats an extraction that read nothing as a failed action', async () => {
    // A target that resolved to something empty has not read the value. Recording it as a
    // success would put an empty entry in the values the next prompt shows, which reads as
    // "already done".
    const llm = new ScriptedLlm([
      action({ type: 'extract', target: BALANCE_FIELD, name: 'savingsBalance' }, 'Read it'),
      JSON.stringify({
        type: 'complete',
        summary: 'The balance was read.',
        outputs: { savingsBalance: '5234.17' },
      }),
    ]);

    const { engine } = engineWith(llm, {
      extract: () => '   ',
      observe: () => ({ textSummary: 'Member Summary' }),
    });

    const result = await engine.discover(REQUEST);

    // Nothing was read, so the completion has nothing to support it.
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_COMPLETION_UNVERIFIED');
    expect(result.trace.entries[0]?.outcome.code).toBe('EXTRACTION_EMPTY');
  });

  it('stops when proposed actions keep failing to be carried out', async () => {
    const script = Array.from({ length: 8 }, (_unused, index) => {
      return action({ type: 'click', target: SEARCH_BUTTON }, `Attempt ${index + 1}`);
    });

    let screen = 0;
    const { engine } = engineWith(new ScriptedLlm(script), {
      click: (): never => {
        throw new Error('the control was not there');
      },
      observe: (): { textSummary: string } => {
        screen += 1;
        return { textSummary: `Screen ${screen}` };
      },
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_DEAD_END');
  });

  it('feeds a single action failure back to the model rather than ending the run', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'click', target: SEARCH_BUTTON }, 'Click the wrong thing'),
      action({ type: 'fill', target: MEMBER_ID_FIELD, value: '12345' }, 'Try the field instead'),
      JSON.stringify({ type: 'complete', summary: 'Done.', outputs: {} }),
    ]);

    let clicked = false;
    const { engine } = engineWith(llm, {
      click: (): never => {
        clicked = true;
        throw new Error('the control was not there');
      },
      observe: (): { textSummary: string } => ({ textSummary: `Screen ${Math.random()}` }),
    });

    const result = await engine.discover(REQUEST);

    expect(clicked).toBe(true);
    expect(result.status).toBe('success');
    // The failure is what the next turn is told about, which is the point of deciding one
    // action at a time.
    expect(llm.requests[1]?.instruction).toContain('failed');
  });
});

describe('escalation', () => {
  it('returns a structured escalation when the model asks for a person', async () => {
    const llm = new ScriptedLlm([
      action({ type: 'click', target: SEARCH_BUTTON }),
      JSON.stringify({
        type: 'escalate',
        reason: 'The application is asking to approve a transfer, which I should not decide.',
      }),
    ]);

    const { engine } = engineWith(llm);
    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('escalation');
    if (result.status !== 'escalation') {
      return;
    }
    expect(result.source).toBe('model');
    expect(result.reason).toContain('approve a transfer');
    // The run is still described in full, which is what Phase 9 will hand to a person.
    expect(result.stepCount).toBe(1);
    expect(result.trace.entries).toHaveLength(1);
  });
});

describe('failures below the loop', () => {
  it('turns a surface that has gone away into a structured discovery failure', async () => {
    const llm = new ScriptedLlm([action({ type: 'click', target: SEARCH_BUTTON })]);

    const { engine } = engineWith(llm, {
      click: (): never => {
        throw new SurfaceUnavailableError('the browser was closed');
      },
    });

    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('DISCOVERY_SURFACE_UNAVAILABLE');
  });

  it('turns a provider failure into a provider-kind result rather than an exception', async () => {
    const llm = new ScriptedLlm([
      (): never => {
        throw new ModelError('MODEL_RATE_LIMITED', 'The model provider is rate limiting.');
      },
    ]);

    const { engine } = engineWith(llm);
    const result = await engine.discover(REQUEST);

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.kind).toBe('provider');
    expect(result.code).toBe('DISCOVERY_MODEL_UNAVAILABLE');
    expect(result.message).toContain('MODEL_RATE_LIMITED');
  });
});
