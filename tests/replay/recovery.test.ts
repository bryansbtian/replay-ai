import { describe, expect, it } from 'vitest';

import { ReplayEngine } from '../../src/replay/index.js';

import {
  artifact,
  balanceTarget,
  continueButtonTarget,
  declaredStates,
  fullArtifact,
  recordingLogger,
  searchButtonTarget,
  silentLogger,
  TEST_TIMEOUTS,
  type JsonObject,
} from './support/artifacts.js';
import { FakeSurface } from './support/fakeSurface.js';

/**
 * Deterministic recovery from a declared runtime condition.
 *
 * The property under test throughout is that recovery is knowledge, not optimism: the
 * engine clears a state the artifact wrote down, retries the step it already tried, and
 * gives up on a bound the artifact set. Nothing here consults anything at run time.
 */

const DIALOG = 'Session Warning Dialog';
const SUMMARY = 'Member Summary Region';

function engineWith(surface: FakeSurface): ReplayEngine {
  return new ReplayEngine({
    surface,
    logger: silentLogger(),
    timeouts: TEST_TIMEOUTS,
    replayId: 'replay-under-test',
  });
}

/**
 * A console that answers the search with a session dialog, and shows the summary only
 * once the dialog has been acknowledged `clearsAfter` times.
 */
function consoleWithDialog(clearsAfter: number): FakeSurface {
  let acknowledged = 0;
  const surface: FakeSurface = new FakeSurface({
    extract: () => '5234.17',
    click: (target) => {
      if (target.description === continueButtonTarget()['description']) {
        acknowledged += 1;
      }
    },
    waitFor: (condition) => {
      if (condition.type === 'textVisible') {
        return condition.text === 'Demo Member Lookup';
      }
      if (condition.type !== 'targetVisible') {
        return false;
      }
      if (condition.target.description === DIALOG) {
        return acknowledged < clearsAfter;
      }
      if (condition.target.description === SUMMARY) {
        return acknowledged >= clearsAfter;
      }
      return false;
    },
  });
  return surface;
}

function stated(overrides: JsonObject = {}) {
  return fullArtifact({ ...declaredStates(), ...overrides });
}

describe('a recognized condition that clears', () => {
  it('recovers, resumes the workflow, and finishes successfully', async () => {
    const surface = consoleWithDialog(1);

    const result = await engineWith(surface).run(stated(), { memberId: '77777' });

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(result.outputs).toEqual({ savingsBalance: 5234.17 });
    expect(result.recoveries).toEqual([
      {
        code: 'KNOWN_SESSION_DIALOG',
        stepId: 'await-summary',
        attempt: 1,
        succeeded: true,
        durationMs: expect.any(Number) as number,
      },
    ]);
  });

  it('activates only the control the artifact named, and retries the step it already tried', async () => {
    const surface = consoleWithDialog(1);

    await engineWith(surface).run(stated(), { memberId: '77777' });

    expect(
      surface.calls.filter((call) => call.method === 'click').map((call) => call.subject),
    ).toEqual(['Search Button', 'Session Warning Continue Button']);
    // The search is not repeated: recovery retries the step that failed, which was the
    // wait, not the submit that preceded it.
    expect(surface.fills).toHaveLength(1);
  });

  it('applies the recovery a second time when the condition returns', async () => {
    const surface = consoleWithDialog(2);

    const result = await engineWith(surface).run(stated(), { memberId: '77777' });

    expect(result.status).toBe('success');
    expect(result.recoveries.map((record) => record.attempt)).toEqual([1, 2]);
  });

  it('logs the condition, the attempt, and the outcome', async () => {
    const { logger, records } = recordingLogger();
    await new ReplayEngine({
      surface: consoleWithDialog(1),
      logger,
      timeouts: TEST_TIMEOUTS,
    }).run(stated(), { memberId: '77777' });

    const messages = records().map((record) => record['message']);
    expect(messages).toContain('Recoverable Condition Detected');
    expect(messages).toContain('Recovery Attempt Started');
    expect(messages).toContain('Recovery Attempt Succeeded');
    expect(messages).not.toContain('Recovery Exhausted');
  });
});

describe('a recognized condition that will not clear', () => {
  it('gives up at the declared bound and returns a structured failure', async () => {
    // The dialog needs three acknowledgements; the artifact allows two.
    const surface = consoleWithDialog(3);

    const result = await engineWith(surface).run(stated(), { memberId: '77777' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_RECOVERY_EXHAUSTED');
    expect(result.kind).toBe('recoveryExhausted');
    expect(result.stepId).toBe('await-summary');
    expect(result.expected).toBe('Target "Member Summary Region" Is Visible');
  });

  it('never reports itself as still recoverable once the bound is spent', async () => {
    const result = await engineWith(consoleWithDialog(3)).run(stated(), { memberId: '77777' });

    expect(result.status).toBe('failure');
    expect(result.recoveries).toHaveLength(2);
    expect(result.recoveries.every((record) => record.succeeded)).toBe(true);
  });

  it('respects the declared maximum exactly', async () => {
    const surface = consoleWithDialog(9);

    await engineWith(surface).run(stated(), { memberId: '77777' });

    const dismissals = surface.calls.filter(
      (call) => call.subject === 'Session Warning Continue Button',
    );
    expect(dismissals).toHaveLength(2);
  });

  it('logs the exhaustion with the code that ran out', async () => {
    const { logger, records } = recordingLogger();
    await new ReplayEngine({
      surface: consoleWithDialog(9),
      logger,
      timeouts: TEST_TIMEOUTS,
    }).run(stated(), { memberId: '77777' });

    const exhausted = records().find((record) => record['message'] === 'Recovery Exhausted');
    expect(exhausted?.['codes']).toEqual(['KNOWN_SESSION_DIALOG', 'KNOWN_SESSION_DIALOG']);
  });

  it('reports the recovery as unsuccessful when the control itself cannot be used', async () => {
    let acknowledged = false;
    const surface = new FakeSurface({
      extract: () => '5234.17',
      click: (target) => {
        if (target.description === 'Session Warning Continue Button') {
          acknowledged = true;
          throw new Error('the control is covered by an overlay');
        }
      },
      waitFor: (condition) => {
        if (condition.type === 'textVisible') {
          return condition.text === 'Demo Member Lookup';
        }
        if (condition.type !== 'targetVisible') {
          return false;
        }
        return condition.target.description === DIALOG;
      },
    });

    const result = await engineWith(surface).run(stated(), { memberId: '77777' });

    expect(acknowledged).toBe(true);
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_RECOVERY_EXHAUSTED');
    expect(result.recoveries).toEqual([
      expect.objectContaining({ code: 'KNOWN_SESSION_DIALOG', succeeded: false }),
    ]);
  });
});

describe('what recovery refuses to do', () => {
  it('leaves a step that changes the application alone, however recognizable the state', async () => {
    let dialogUp = true;
    const surface = new FakeSurface({
      extract: () => '5234.17',
      click: (target) => {
        if (target.description === 'Session Warning Continue Button') {
          dialogUp = false;
          return;
        }
        throw new Error('the dialog is covering the control');
      },
      waitFor: (condition) => {
        if (condition.type === 'textVisible') {
          return condition.text === 'Demo Member Lookup';
        }
        if (condition.type !== 'targetVisible') {
          return false;
        }
        return condition.target.description === DIALOG && dialogUp;
      },
    });

    const withRiskySubmit = artifact({
      ...declaredStates(),
      inputs: [],
      outputs: [],
      steps: [{ id: 'submit-search', type: 'click', target: searchButtonTarget(), risk: 'risky' }],
    });

    const result = await engineWith(surface).run(withRiskySubmit, {});

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.kind).toBe('terminal');
    expect(result.recoveries).toEqual([]);
    expect(dialogUp).toBe(true);
  });

  it('does not run for a failure no interstitial could explain', async () => {
    // A value that cannot be read as the declared type is not a state a dialog is
    // hiding, so the declared recovery is never even looked at.
    const surface = new FakeSurface({
      extract: () => '$1,024.50',
      waitFor: (condition) => {
        if (condition.type === 'textVisible') {
          return condition.text === 'Demo Member Lookup';
        }
        return condition.type === 'targetVisible' && condition.target.description === SUMMARY;
      },
    });

    const result = await engineWith(surface).run(stated(), { memberId: '24680' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_OUTPUT_TYPE_MISMATCH');
    expect(result.recoveries).toEqual([]);
    expect(surface.calls.filter((call) => call.subject === DIALOG)).toHaveLength(0);
  });

  it('costs a healthy run nothing', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      waitFor: (condition) => {
        if (condition.type === 'textVisible') {
          return condition.text === 'Demo Member Lookup';
        }
        return condition.type === 'targetVisible' && condition.target.description === SUMMARY;
      },
    });

    const result = await engineWith(surface).run(stated(), { memberId: '12345' });

    expect(result.status).toBe('success');
    expect(surface.calls.filter((call) => call.subject === DIALOG)).toHaveLength(0);
  });

  it('extracts nothing extra: the artifact still decides what is read', async () => {
    const surface = consoleWithDialog(1);

    await engineWith(surface).run(stated(), { memberId: '77777' });

    expect(
      surface.calls.filter((call) => call.method === 'extract').map((call) => call.subject),
    ).toEqual([balanceTarget()['description']]);
  });
});
