import { describe, expect, it, vi } from 'vitest';

import type { InterventionContext } from '../../src/execution/index.js';
import { AutomationSession, HandoffCoordinator } from '../../src/handoff/index.js';
import type { HumanAction } from '../../src/surfaces/index.js';
import { RecordingEvidence, silentLogger } from '../discovery/support/fakes.js';
import { FakeSurface } from '../replay/support/fakeSurface.js';

/**
 * The mechanism: pause here, hand the session over, take it back.
 *
 * The surface is scripted so these run without a browser, and the evidence recorder is the
 * in-memory one, so what is being tested is the coordination rather than Playwright. The
 * one thing that cannot be faked here is the pause, and it is not: `request` really does
 * return a promise that nothing resolves until an operator acts.
 */

/**
 * Lets the coordinator finish the awaits it does before it pauses.
 *
 * `request` observes the surface and captures a screenshot first, so the session is not
 * waiting yet on the turn after the call. A macrotask is the honest way to say "after
 * everything already queued".
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const CONTEXT: InterventionContext = {
  source: 'replay',
  reason: 'UNRECOVERABLE_FAILURE',
  subject: 'Lookup Member Balance',
  stepId: 'await-member-summary',
  code: 'REPLAY_WAIT_TIMEOUT',
  detail: 'The member summary never appeared.',
};

/** A surface that can be handed to a person, like the Playwright one. */
class ControllableSurface extends FakeSurface {
  sink: ((action: HumanAction) => void) | undefined;
  beganTimes = 0;
  endedTimes = 0;

  beginHumanControl(onAction: (action: HumanAction) => void): Promise<void> {
    this.beganTimes += 1;
    this.sink = onAction;
    return Promise.resolve();
  }

  endHumanControl(): Promise<void> {
    this.endedTimes += 1;
    this.sink = undefined;
    return Promise.resolve();
  }
}

interface Harness {
  readonly coordinator: HandoffCoordinator;
  readonly session: AutomationSession;
  readonly surface: ControllableSurface;
  readonly evidence: RecordingEvidence;
}

function harness(options: { timeoutMs?: number } = {}): Harness {
  const session = new AutomationSession({
    id: 'session-1',
    runId: 'run-1',
    automation: 'replay',
    subject: 'Lookup Member Balance',
    now: () => new Date('2026-08-19T10:00:00.000Z'),
  });
  const surface = new ControllableSurface({ url: 'https://demo.replay-ai.test/members?ref=12345' });
  const evidence = new RecordingEvidence();
  const coordinator = new HandoffCoordinator({
    session,
    surface,
    evidence,
    logger: silentLogger(),
    now: () => new Date('2026-08-19T10:00:00.000Z'),
    newId: () => 'intervention-1',
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  });
  return { coordinator, session, surface, evidence };
}

describe('asking for a person', () => {
  it('pauses the run and does not resolve until an operator acts', async () => {
    const { coordinator, session } = harness();
    const settled = vi.fn();

    const pending = coordinator.request(CONTEXT).then(settled);
    await flush();

    // The engine is inside this await. Nothing has resolved, which is what the pause is.
    expect(settled).not.toHaveBeenCalled();
    expect(session.state).toBe('waitingForHuman');
    expect(session.automationMayAct).toBe(false);

    await coordinator.takeControl();
    await coordinator.resume();
    await pending;

    expect(settled).toHaveBeenCalledWith({ status: 'resolved' });
  });

  it('builds a request a person can act on, with nothing sensitive in it', async () => {
    const { coordinator, session } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();

    const intervention = session.intervention;
    expect(intervention).toMatchObject({
      id: 'intervention-1',
      sessionId: 'session-1',
      runId: 'run-1',
      source: 'replay',
      reason: 'UNRECOVERABLE_FAILURE',
      subject: 'Lookup Member Balance',
      stepId: 'await-member-summary',
      code: 'REPLAY_WAIT_TIMEOUT',
    });
    // The query value is redacted by the shared rules, so a reference cannot reach the
    // operator page through the URL. It arrives percent-encoded because the redaction goes
    // through `URL`, which is the same form evidence records.
    expect(intervention?.url).toContain('ref=%5Bredacted%5D');
    expect(intervention?.url).not.toContain('12345');

    await coordinator.abort('done');
    await pending;
  });

  it('captures the screen that stopped the run', async () => {
    const { coordinator, session, evidence } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();

    expect(session.intervention?.screenshot).toBeDefined();
    expect(evidence.screenshots).toHaveLength(1);

    await coordinator.abort('done');
    await pending;
  });

  it('records the request and the pause as two separate moments', async () => {
    const { coordinator, evidence } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();

    expect(evidence.names()).toEqual(['intervention_requested', 'automation_paused']);

    await coordinator.abort('done');
    await pending;
  });
});

describe('taking control', () => {
  it('hands over the session that was already open, and records it', async () => {
    const { coordinator, session, surface, evidence } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();

    await coordinator.takeControl();

    expect(session.controlOwner).toBe('human');
    expect(surface.beganTimes).toBe(1);
    // Nothing was launched or navigated: the surface handed over is the one in use.
    expect(surface.methods()).not.toContain('navigate');
    expect(evidence.names()).toContain('human_control_started');

    await coordinator.abort('done');
    await pending;
  });

  it('is refused when nobody has been asked for', async () => {
    const { coordinator } = harness();

    await expect(coordinator.takeControl()).rejects.toThrow(/cannot move to/);
  });

  it('is refused a second time', async () => {
    const { coordinator } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();

    await expect(coordinator.takeControl()).rejects.toThrow(/cannot move to/);

    await coordinator.abort('done');
    await pending;
  });
});

describe('what a person did', () => {
  it('is recorded as a type and a label, never as a value', async () => {
    const { coordinator, session, surface, evidence } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();

    surface.sink?.({
      actionType: 'fill',
      target: 'Verification Code',
      role: 'input',
      url: 'https://demo.replay-ai.test/members',
      at: '2026-08-19T10:00:05.000Z',
    });
    await flush();

    expect(session.humanActions[0]).toMatchObject({
      actionType: 'fill',
      target: 'Verification Code',
    });
    // The value a person typed during a handoff is usually the thing that stopped the run,
    // which is a code or a credential. There is no field for it anywhere in the chain.
    const recorded = evidence.named('human_action')[0];
    expect(Object.keys(recorded?.fields ?? {})).not.toContain('value');
    expect(evidence.serialized()).not.toContain('123456');

    await coordinator.abort('done');
    await pending;
  });

  it('keeps clicks and navigations in order', async () => {
    const { coordinator, session, surface } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();

    surface.sink?.({ actionType: 'click', target: 'Continue', url: 'https://x.test/', at: '1' });
    surface.sink?.({ actionType: 'navigate', url: 'https://x.test/next', at: '2' });
    await flush();

    expect(session.humanActions.map((action) => action.actionType)).toEqual(['click', 'navigate']);

    await coordinator.abort('done');
    await pending;
  });

  it('drops an event that arrives after control has gone back', async () => {
    const { coordinator, session, surface } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();
    const sink = surface.sink;
    await coordinator.resume();
    await pending;

    // A browser callback in flight when the operator pressed Resume is late, not wrong.
    expect(() => sink?.({ actionType: 'click', url: 'https://x.test/', at: '3' })).not.toThrow();
    expect(session.humanActions).toHaveLength(0);
  });
});

describe('handing control back', () => {
  it('stops recording and releases the paused run', async () => {
    const { coordinator, surface, evidence } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();

    await coordinator.resume();
    const outcome = await pending;

    expect(outcome).toEqual({ status: 'resolved' });
    expect(surface.endedTimes).toBe(1);
    expect(evidence.names()).toContain('human_control_ended');
  });

  it('leaves the session resuming until the engine says what it found', async () => {
    const { coordinator, session } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();
    await coordinator.resume();
    await pending;

    expect(session.state).toBe('resuming');
    expect(session.automationMayAct).toBe(false);

    await coordinator.settle({ resumed: true });

    expect(session.state).toBe('running');
    expect(session.controlOwner).toBe('replay');
    expect(session.automationMayAct).toBe(true);
  });

  it('fails the session when the engine could not continue', async () => {
    const { coordinator, session, evidence } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();
    await coordinator.resume();
    await pending;

    await coordinator.settle({ resumed: false, detail: 'the summary still is not there' });

    expect(session.state).toBe('failed');
    expect(evidence.names()).toContain('resume_failed');
  });
});

describe('aborting', () => {
  it('releases the run with an abort and records it', async () => {
    const { coordinator, session, evidence } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();

    await coordinator.abort('An operator ended the session.');
    const outcome = await pending;

    expect(outcome).toEqual({ status: 'aborted', reason: 'An operator ended the session.' });
    expect(session.state).toBe('aborted');
    expect(evidence.names()).toContain('session_aborted');
  });

  it('leaves nothing that can resume afterwards', async () => {
    const { coordinator } = harness();
    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();
    await coordinator.abort('done');
    await pending;

    await expect(coordinator.resume()).rejects.toThrow();
  });
});

describe('a request nobody answers', () => {
  it('gives up after the configured wait and fails the session', async () => {
    const { coordinator, session, evidence } = harness({ timeoutMs: 10 });

    const outcome = await coordinator.request(CONTEXT);

    expect(outcome.status).toBe('unavailable');
    expect(session.state).toBe('failed');
    expect(evidence.names()).toContain('intervention_timeout');
  });
});

describe('a surface that cannot be handed to a person', () => {
  it('still transfers control, and says the actions will not be recorded', async () => {
    const session = new AutomationSession({
      id: 'session-2',
      runId: 'run-2',
      automation: 'replay',
      subject: 'Lookup Member Balance',
    });
    const coordinator = new HandoffCoordinator({
      session,
      // A plain surface with no human-control methods, which is what a headless or
      // API-driven surface looks like.
      surface: new FakeSurface({ url: 'https://demo.replay-ai.test/members' }),
      evidence: new RecordingEvidence(),
      logger: silentLogger(),
    });

    const pending = coordinator.request(CONTEXT);
    await flush();
    await coordinator.takeControl();

    expect(session.controlOwner).toBe('human');

    await coordinator.abort('done');
    await pending;
  });
});
