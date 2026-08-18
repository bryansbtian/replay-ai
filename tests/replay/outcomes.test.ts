import { describe, expect, it } from 'vitest';

import { ReplayEngine, type ReplayResult } from '../../src/replay/index.js';
import { TargetNotFoundError } from '../../src/surfaces/index.js';

import {
  artifact,
  declaredStates,
  fullArtifact,
  recordingLogger,
  silentLogger,
  TEST_TIMEOUTS,
  type JsonObject,
} from './support/artifacts.js';
import { FakeSurface, type FakeBehavior } from './support/fakeSurface.js';

/**
 * The Phase 5 question: when a run does not succeed normally, what exactly happened?
 *
 * Each case here drives the engine with a scripted surface so that the state the
 * application is in is stated outright rather than produced by a browser. The same
 * distinctions are proved against a real page in `browserReplay.test.ts`.
 */

const SUMMARY_TEXT = 'No Member Matches That Reference';
const PERMISSION_TEXT = 'You Do Not Have Permission To View This Member';

function engineWith(surface: FakeSurface, options: { stepTimeoutMs?: number } = {}): ReplayEngine {
  return new ReplayEngine({
    surface,
    logger: silentLogger(),
    timeouts: TEST_TIMEOUTS,
    replayId: 'replay-under-test',
    ...options,
  });
}

/**
 * What the application is showing, stated exactly.
 *
 * Nothing is visible unless a case says it is, which is what lets a test prove that an
 * interstitial the artifact never declared is left alone: if it were listed here, the
 * engine would be free to recognize it.
 */
interface Screen {
  readonly texts?: readonly string[];
  readonly targets?: readonly string[];
}

function surfaceShowing(screen: Screen, behavior: FakeBehavior = {}): FakeSurface {
  // The lookup screen is always up, so every case reaches the step it is about.
  const texts = new Set(['Demo Member Lookup', ...(screen.texts ?? [])]);
  const targets = new Set(screen.targets ?? []);

  return new FakeSurface({
    extract: () => '5234.17',
    waitFor: (condition) => {
      if (condition.type === 'textVisible') {
        return texts.has(condition.text);
      }
      if (condition.type === 'targetVisible') {
        return targets.has(condition.target.description);
      }
      return false;
    },
    ...behavior,
  });
}

function stated(overrides: JsonObject = {}): ReturnType<typeof fullArtifact> {
  return fullArtifact({ ...declaredStates(), ...overrides });
}

describe('a declared business outcome', () => {
  it('is reported as an outcome, never as a failure', async () => {
    const result = await engineWith(surfaceShowing({ texts: [SUMMARY_TEXT] })).run(stated(), {
      memberId: '00000',
    });

    expect(result.status).toBe('businessOutcome');
    if (result.status !== 'businessOutcome') {
      return;
    }
    expect(result.code).toBe('MEMBER_NOT_FOUND');
    expect(result.message).toBe('No member exists for the supplied identifier.');
    expect(result.stepId).toBe('await-summary');
    expect(result.capabilityId).toBe('lookup-demo-member');
  });

  it('carries no outputs, because the workflow did not produce them', async () => {
    const result = await engineWith(surfaceShowing({ texts: [SUMMARY_TEXT] })).run(stated(), {
      memberId: '00000',
    });

    expect(result).not.toHaveProperty('outputs');
    expect(result).not.toHaveProperty('code', 'REPLAY_WAIT_TIMEOUT');
  });

  it('is detected when the final success condition is what failed', async () => {
    // Every step passes; only the capability's own success condition does not.
    const surface = surfaceShowing({
      texts: [SUMMARY_TEXT],
      targets: ['Member Summary Region'],
    });
    const withFailingSuccess = stated({
      successCondition: { type: 'textVisible', text: 'Member Summary' },
    });

    const result = await engineWith(surface).run(withFailingSuccess, { memberId: '00000' });

    expect(result.status).toBe('businessOutcome');
    expect(result).not.toHaveProperty('stepId');
  });

  it('is not looked for when a control could not be operated', async () => {
    // The screen may well say "no member matches"; a button that cannot be clicked is
    // still an automation problem rather than an answer.
    const surface = surfaceShowing(
      { texts: [SUMMARY_TEXT] },
      {
        click: () => {
          throw new TargetNotFoundError('Search Button', []);
        },
      },
    );

    const result = await engineWith(surface).run(stated(), { memberId: '00000' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_TARGET_NOT_FOUND');
  });
});

describe('a declared state the artifact marks as a failure', () => {
  it('stops the run with the declared code rather than a generic checkpoint failure', async () => {
    const result = await engineWith(surfaceShowing({ texts: [PERMISSION_TEXT] })).run(stated(), {
      memberId: '99999',
    });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.kind).toBe('terminal');
    expect(result.message).toBe('The operator is not permitted to view this member.');
    expect(result.stepId).toBe('await-summary');
  });

  it('is never mistaken for a business outcome the caller can act on', async () => {
    const result = await engineWith(surfaceShowing({ texts: [PERMISSION_TEXT] })).run(stated(), {
      memberId: '99999',
    });

    expect(result.status).not.toBe('businessOutcome');
  });

  it('is not recovered from, whatever else is on screen', async () => {
    // The session dialog is showing too. The declared failure still wins, because
    // dismissing a dialog cannot grant permission.
    const surface = surfaceShowing({
      texts: [PERMISSION_TEXT],
      targets: ['Session Warning Dialog'],
    });

    const result = await engineWith(surface).run(stated(), { memberId: '99999' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(surface.calls.filter((call) => call.method === 'click')).toHaveLength(1);
  });

  it('logs the detection so an operator can see why the run stopped', async () => {
    const { logger, records } = recordingLogger();
    await new ReplayEngine({
      surface: surfaceShowing({ texts: [PERMISSION_TEXT] }),
      logger,
      timeouts: TEST_TIMEOUTS,
    }).run(stated(), { memberId: '99999' });

    const detected = records().find(
      (record) => record['message'] === 'Declared Failure State Detected',
    );
    expect(detected?.['code']).toBe('PERMISSION_DENIED');
  });
});

describe('an application state nothing declares', () => {
  it('stops the run rather than interpreting it', async () => {
    const surface = surfaceShowing({ texts: ['Confirm Unusual Activity'] });

    const result = await engineWith(surface).run(stated(), { memberId: '66666' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_WAIT_TIMEOUT');
    expect(result.kind).toBe('terminal');
  });

  it('never activates a control the artifact did not name', async () => {
    const surface = surfaceShowing({ texts: ['Confirm Unusual Activity'] });

    await engineWith(surface).run(stated(), { memberId: '66666' });

    const clicked = surface.calls.filter((call) => call.method === 'click');
    expect(clicked.map((call) => call.subject)).toEqual(['Search Button']);
  });
});

describe('a capability that declares nothing', () => {
  it('reports the step failure directly, with no classification work at all', async () => {
    const surface = surfaceShowing({ texts: [SUMMARY_TEXT] });

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '00000' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_WAIT_TIMEOUT');
    expect(result.recoveries).toEqual([]);
  });
});

describe('every result', () => {
  it('reports the recoveries it performed, empty on a clean run', async () => {
    const surface = surfaceShowing({ targets: ['Member Summary Region'] });

    const result: ReplayResult = await engineWith(surface).run(stated(), { memberId: '12345' });

    expect(result.status).toBe('success');
    expect(result.recoveries).toEqual([]);
  });

  it('never carries a raw browser exception or a stack', async () => {
    const surface = surfaceShowing(
      { targets: ['Member Summary Region'] },
      {
        click: () => {
          throw new Error('locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for x');
        },
      },
    );

    const result = await engineWith(surface).run(stated(), { memberId: '12345' });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Call log');
    expect(serialized).not.toContain('at ');
    expect(serialized).not.toContain('waiting for x');
  });
});

describe('an artifact that declares a state and a recovery under one code', () => {
  it('is rejected by validation before a run can be confused by it', () => {
    expect(() =>
      artifact({
        ...declaredStates(),
        recoveries: [
          {
            code: 'MEMBER_NOT_FOUND',
            description: 'A code that means two things at once.',
            condition: { type: 'textVisible', text: SUMMARY_TEXT },
            action: {
              type: 'dismiss',
              target: {
                description: 'Continue Button',
                strategies: [{ kind: 'role', role: 'button', name: 'Continue' }],
              },
            },
          },
        ],
        inputs: [],
        outputs: [],
        steps: [
          { id: 'open-lookup', type: 'navigate', url: 'https://demo.replay-ai.test/members' },
        ],
      }),
    ).toThrow(/already declared as a business outcome/);
  });
});
