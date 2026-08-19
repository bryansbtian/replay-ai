import { describe, expect, it } from 'vitest';

import {
  AutomationSession,
  ControlOwnershipError,
  InvalidSessionTransitionError,
} from '../../src/handoff/index.js';
import type { InterventionRequest } from '../../src/handoff/index.js';

/**
 * The state machine that makes only one actor able to act at a time.
 *
 * These are the tests that matter most for the safety of a handoff. Everything else in the
 * phase (a server, a page, a coordinator) is plumbing around this: if two owners can exist
 * at once, or a session can be resumed after being aborted, then automation and a person
 * can touch the same browser at the same time and no amount of UI prevents it.
 */

const REQUEST: InterventionRequest = {
  id: 'intervention-1',
  sessionId: 'session-1',
  runId: 'run-1',
  source: 'replay',
  reason: 'UNRECOVERABLE_FAILURE',
  subject: 'Lookup Member Balance',
  stepId: 'await-member-summary',
  code: 'REPLAY_WAIT_TIMEOUT',
  detail: 'The member summary never appeared.',
  url: 'http://127.0.0.1/member-lookup.html',
  requestedAt: '2026-08-19T10:00:00.000Z',
};

function session(automation: 'replay' | 'discovery' = 'replay'): AutomationSession {
  return new AutomationSession({
    id: 'session-1',
    runId: 'run-1',
    automation,
    subject: 'Lookup Member Balance',
    now: () => new Date('2026-08-19T10:00:00.000Z'),
  });
}

/** Walks a session to the point where a person holds it, which most cases start from. */
function underHumanControl(): AutomationSession {
  const subject = session();
  subject.requestIntervention(REQUEST);
  subject.takeControl();
  return subject;
}

describe('a new session', () => {
  it('belongs to the automation that started it', () => {
    const subject = session();

    expect(subject.state).toBe('running');
    expect(subject.controlOwner).toBe('replay');
    expect(subject.automationMayAct).toBe(true);
  });

  it('belongs to discovery when discovery started it', () => {
    expect(session('discovery').controlOwner).toBe('discovery');
  });
});

describe('asking for a person', () => {
  it('pauses the run and gives the session to nobody', () => {
    const subject = session();

    subject.requestIntervention(REQUEST);

    // Not straight to the human: the request exists and automation has stopped, but until
    // somebody takes control there is nobody to hand the browser to.
    expect(subject.state).toBe('waitingForHuman');
    expect(subject.controlOwner).toBe('none');
    expect(subject.automationMayAct).toBe(false);
    expect(subject.intervention).toEqual(REQUEST);
  });

  it('stops automation acting from the moment it is asked', () => {
    const subject = session();

    subject.requestIntervention(REQUEST);

    expect(subject.automationMayAct).toBe(false);
  });
});

describe('taking control', () => {
  it('makes the person the owner while automation stays paused', () => {
    const subject = underHumanControl();

    expect(subject.state).toBe('humanControl');
    expect(subject.controlOwner).toBe('human');
    expect(subject.automationMayAct).toBe(false);
  });

  it('cannot happen twice', () => {
    const subject = underHumanControl();

    // `humanControl` cannot reach itself, so a second operator pressing the same button
    // is refused by the table rather than by a guard somebody has to remember to write.
    expect(() => subject.takeControl()).toThrow(InvalidSessionTransitionError);
  });

  it('cannot happen before a person has been asked for', () => {
    const subject = session();

    expect(() => subject.takeControl()).toThrow(InvalidSessionTransitionError);
  });
});

describe('handing control back', () => {
  it('goes through resuming rather than straight back to running', () => {
    const subject = underHumanControl();

    subject.beginResume();

    // Whether the run may continue is a question about the application, and the engine has
    // to look before it is answered.
    expect(subject.state).toBe('resuming');
    expect(subject.controlOwner).toBe('none');
    expect(subject.automationMayAct).toBe(false);
  });

  it('returns the session to the automation that started it', () => {
    const subject = underHumanControl();

    subject.beginResume();
    subject.completeResume();

    expect(subject.state).toBe('running');
    expect(subject.controlOwner).toBe('replay');
    expect(subject.automationMayAct).toBe(true);
    expect(subject.intervention).toBeUndefined();
  });

  it('cannot be resumed by somebody who does not hold it', () => {
    const subject = session();
    subject.requestIntervention(REQUEST);

    expect(() => subject.beginResume()).toThrow(ControlOwnershipError);
  });

  it('cannot be resumed twice', () => {
    const subject = underHumanControl();
    subject.beginResume();

    expect(() => subject.beginResume()).toThrow(ControlOwnershipError);
  });
});

describe('aborting', () => {
  it('ends the session and lets nothing continue', () => {
    const subject = underHumanControl();

    subject.abort();

    expect(subject.state).toBe('aborted');
    expect(subject.controlOwner).toBe('none');
    expect(subject.isTerminal).toBe(true);
    expect(subject.automationMayAct).toBe(false);
  });

  it('cannot be resumed afterwards', () => {
    const subject = underHumanControl();
    subject.abort();

    expect(() => subject.beginResume()).toThrow(ControlOwnershipError);
    expect(() => subject.takeControl()).toThrow(InvalidSessionTransitionError);
  });

  it('can end a session nobody has taken yet', () => {
    const subject = session();
    subject.requestIntervention(REQUEST);

    subject.abort();

    expect(subject.state).toBe('aborted');
  });
});

describe('a session that has finished', () => {
  it('cannot be handed to anybody', () => {
    const subject = session();
    subject.finish('completed');

    expect(subject.isTerminal).toBe(true);
    expect(() => subject.requestIntervention(REQUEST)).toThrow(InvalidSessionTransitionError);
    expect(() => subject.takeControl()).toThrow(InvalidSessionTransitionError);
  });

  it('cannot be aborted after it failed', () => {
    const subject = session();
    subject.finish('failed');

    expect(() => subject.abort()).toThrow(InvalidSessionTransitionError);
  });
});

describe('recording what a person did', () => {
  it('is accepted only while they hold the session', () => {
    const subject = underHumanControl();

    subject.recordHumanAction({
      actionType: 'click',
      target: 'Continue',
      url: 'http://127.0.0.1/member-lookup.html',
      at: '2026-08-19T10:00:01.000Z',
    });

    expect(subject.humanActions).toHaveLength(1);
  });

  it('is refused once control has gone back', () => {
    const subject = underHumanControl();
    subject.beginResume();

    expect(() =>
      subject.recordHumanAction({
        actionType: 'click',
        url: 'http://127.0.0.1/member-lookup.html',
        at: '2026-08-19T10:00:02.000Z',
      }),
    ).toThrow(ControlOwnershipError);
  });

  it('keeps them in the order they happened', () => {
    const subject = underHumanControl();
    for (const target of ['First', 'Second', 'Third']) {
      subject.recordHumanAction({
        actionType: 'click',
        target,
        url: 'http://127.0.0.1/member-lookup.html',
        at: '2026-08-19T10:00:01.000Z',
      });
    }

    expect(subject.humanActions.map((action) => action.target)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });
});

describe('the view an operator page renders', () => {
  it('is a copy, so nothing rendering it can change the session', () => {
    const subject = underHumanControl();

    const view = subject.view();
    expect(view.humanActions).toEqual([]);

    subject.recordHumanAction({
      actionType: 'click',
      url: 'http://127.0.0.1/member-lookup.html',
      at: '2026-08-19T10:00:01.000Z',
    });

    expect(view.humanActions).toEqual([]);
    expect(subject.view().humanActions).toHaveLength(1);
  });

  it('carries the intervention a person is being asked about', () => {
    const subject = underHumanControl();

    expect(subject.view()).toMatchObject({
      id: 'session-1',
      runId: 'run-1',
      state: 'humanControl',
      controlOwner: 'human',
      intervention: { code: 'REPLAY_WAIT_TIMEOUT' },
    });
  });
});
