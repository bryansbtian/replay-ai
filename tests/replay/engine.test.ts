import { describe, expect, it } from 'vitest';

import { ReplayEngine } from '../../src/replay/index.js';
import { TargetNotFoundError } from '../../src/surfaces/index.js';

import {
  artifact,
  balanceTarget,
  fullArtifact,
  memberIdTarget,
  recordingLogger,
  searchButtonTarget,
  silentLogger,
  summaryTarget,
  TEST_TIMEOUTS,
  type JsonObject,
} from './support/artifacts.js';
import { FakeSurface, HangingSurface, type FakeBehavior } from './support/fakeSurface.js';

/**
 * The engine itself: ordering, checkpoints, the final success condition, outputs,
 * retries, budgets, and what a failure reports.
 *
 * Everything here runs against a scripted surface, so each case is about one decision
 * the engine makes rather than about what a browser happens to do. The real chain is
 * proved in `browserReplay.test.ts`.
 */

function engineWith(surface: FakeSurface, options: { stepTimeoutMs?: number } = {}): ReplayEngine {
  return new ReplayEngine({
    surface,
    logger: silentLogger(),
    timeouts: TEST_TIMEOUTS,
    replayId: 'replay-under-test',
    ...options,
  });
}

/** The happy path: a surface that shows every state and reads back a usable balance. */
function workingSurface(behavior: FakeBehavior = {}): FakeSurface {
  return new FakeSurface({ extract: () => '5234.17', ...behavior });
}

describe('a successful replay', () => {
  it('returns the declared outputs, typed as the artifact declared them', async () => {
    const surface = workingSurface();

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(result.outputs).toEqual({ savingsBalance: 5234.17 });
    expect(result.capabilityId).toBe('lookup-demo-member');
    expect(result.capabilityVersion).toBe(3);
    expect(result.replayId).toBe('replay-under-test');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('executes the steps in the order the artifact stores them', async () => {
    const surface = workingSurface();

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    // The trailing waitFor is the capability's success condition, which every replay
    // evaluates after the last step.
    expect(surface.methods()).toEqual([
      'navigate',
      'waitFor',
      'fill',
      'click',
      'waitFor',
      'extract',
      'waitFor',
    ]);
    expect(result.completedSteps.map((step) => step.stepId)).toEqual([
      'open-lookup',
      'confirm-screen',
      'enter-member-id',
      'submit-search',
      'await-summary',
      'read-balance',
    ]);
  });

  it('types the resolved input into the field the step names', async () => {
    const surface = workingSurface();

    await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    expect(surface.fills).toEqual([{ target: 'Member ID Field', value: '12345' }]);
  });

  it('produces the same execution plan for the same artifact and inputs', async () => {
    const first = workingSurface();
    const second = workingSurface();

    await engineWith(first).run(fullArtifact(), { memberId: '12345' });
    await engineWith(second).run(fullArtifact(), { memberId: '12345' });

    expect(first.calls).toEqual(second.calls);
  });

  it('leaves the artifact it replayed unchanged', async () => {
    const replayed = fullArtifact();
    const snapshot = JSON.stringify(replayed);

    await engineWith(workingSurface()).run(replayed, { memberId: '12345' });

    expect(JSON.stringify(replayed)).toBe(snapshot);
  });
});

describe('invocation validation', () => {
  it('fails before touching the surface', async () => {
    const surface = workingSurface();

    const result = await engineWith(surface).run(fullArtifact(), { memberId: 12345 });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_INPUTS_INVALID');
    expect(result.message).toContain('memberId');
    expect(surface.calls).toEqual([]);
  });
});

describe('checkpoints', () => {
  it('stops at a checkpoint step whose state never appeared', async () => {
    const surface = workingSurface({
      waitFor: (condition) => condition.type !== 'textVisible',
    });

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_CHECKPOINT_FAILED');
    expect(result.stepId).toBe('confirm-screen');
    expect(result.stepType).toBe('checkpoint');
    expect(result.expected).toBe('Text "Demo Member Lookup" Is Visible');
    expect(result.observed).toBe('Not Visible');
    // Nothing after the failed checkpoint ran.
    expect(surface.methods()).toEqual(['navigate', 'waitFor']);
  });

  it('distinguishes a wait whose state never arrived from a checkpoint', async () => {
    const surface = workingSurface({
      waitFor: (condition) => condition.type !== 'targetVisible',
    });

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_WAIT_FAILED');
    expect(result.stepId).toBe('await-summary');
  });

  it('renders every checkpoint type as an expectation a reader can act on', async () => {
    const conditions: { condition: JsonObject; expected: string }[] = [
      {
        condition: { type: 'targetVisible', target: summaryTarget() },
        expected: 'Target "Member Summary Region" Is Visible',
      },
      {
        condition: {
          type: 'targetContainsText',
          target: summaryTarget(),
          text: 'Member Summary',
        },
        expected: 'Target "Member Summary Region" Contains "Member Summary"',
      },
      {
        condition: { type: 'textVisible', text: 'Member Summary' },
        expected: 'Text "Member Summary" Is Visible',
      },
      {
        condition: { type: 'urlMatches', pattern: '/members/\\d+$' },
        expected: 'URL Matches //members/\\d+$/',
      },
    ];

    for (const { condition, expected } of conditions) {
      const surface = new FakeSurface({ waitFor: () => false });
      const result = await engineWith(surface).run(
        artifact({
          inputs: [],
          outputs: [],
          steps: [{ id: 'assert-state', type: 'checkpoint', condition }],
        }),
        {},
      );

      expect(result.status).toBe('failure');
      if (result.status !== 'failure') {
        return;
      }
      expect(result.expected).toBe(expected);
    }
  });
});

describe('the final success condition', () => {
  it('refuses to report success when every step ran but the state was never reached', async () => {
    let stepsFinished = false;
    const surface = new FakeSurface({
      extract: () => {
        stepsFinished = true;
        return '5234.17';
      },
      // Every condition holds until the last one, which is the success condition.
      waitFor: () => !stepsFinished,
    });

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_SUCCESS_CONDITION_FAILED');
    expect(result.expected).toBe('Target "Member Summary Region" Is Visible');
    expect(result.completedSteps).toHaveLength(6);
  });

  it('is evaluated even for a capability whose only step is a navigation', async () => {
    const surface = new FakeSurface({ waitFor: () => false });

    const result = await engineWith(surface).run(
      artifact({
        inputs: [],
        outputs: [],
        steps: [
          { id: 'open-lookup', type: 'navigate', url: 'https://demo.replay-ai.test/members' },
        ],
      }),
      {},
    );

    expect(result.status).toBe('failure');
    expect(surface.methods()).toEqual(['navigate', 'waitFor']);
  });
});

describe('business outcomes', () => {
  const withOutcome = (overrides: JsonObject = {}): JsonObject => {
    return {
      businessOutcomes: [
        {
          code: 'MEMBER_NOT_FOUND',
          description: 'The demo console reports that no member matches the supplied id.',
          condition: { type: 'textVisible', text: 'No Member Matches That Reference' },
        },
      ],
      ...overrides,
    };
  };

  it('reports a declared outcome instead of a crash when a wait never resolves', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      waitFor: (condition) => {
        if (condition.type === 'textVisible' && condition.text.startsWith('No Member')) {
          return true;
        }
        return condition.type !== 'targetVisible';
      },
    });

    const result = await engineWith(surface).run(fullArtifact(withOutcome()), {
      memberId: '00000',
    });

    expect(result.status).toBe('businessOutcome');
    if (result.status !== 'businessOutcome') {
      return;
    }
    expect(result.code).toBe('MEMBER_NOT_FOUND');
    expect(result.stepId).toBe('await-summary');
    expect(result.description).toContain('no member matches');
  });

  it('still reports a failure when no declared outcome matches', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      waitFor: (condition) => {
        if (condition.type === 'textVisible') {
          return !condition.text.startsWith('No Member');
        }
        return false;
      },
    });

    const result = await engineWith(surface).run(fullArtifact(withOutcome()), {
      memberId: '00000',
    });

    expect(result.status).toBe('failure');
  });

  it('does not treat a control that could not be operated as a business answer', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      click: () => {
        throw new TargetNotFoundError('Search Button', []);
      },
      waitFor: () => true,
    });

    const result = await engineWith(surface).run(fullArtifact(withOutcome()), {
      memberId: '00000',
    });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_STEP_FAILED');
  });
});

describe('failure context', () => {
  it('names the capability, the step, the action, and what went wrong', async () => {
    const surface = new FakeSurface({
      click: () => {
        throw new TargetNotFoundError('Search Button', []);
      },
    });

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.capabilityId).toBe('lookup-demo-member');
    expect(result.stepId).toBe('submit-search');
    expect(result.stepType).toBe('click');
    expect(result.code).toBe('REPLAY_STEP_FAILED');
    expect(result.cause).toContain('SURFACE_TARGET_NOT_FOUND');
    expect(result.completedSteps.map((step) => step.stepId)).toEqual([
      'open-lookup',
      'confirm-screen',
      'enter-member-id',
    ]);
  });

  it('reports an unexpected failure without leaking the original exception', async () => {
    const surface = new FakeSurface({
      navigate: () => {
        throw new Error('socket hang up\n  at internal frame');
      },
    });

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_UNEXPECTED');
    expect(result.cause).toBe('Error: socket hang up');
    expect(result.cause).not.toContain('internal frame');
  });
});

describe('retries', () => {
  const clickArtifact = (execution: JsonObject, risk = 'safe'): JsonObject => {
    return {
      inputs: [],
      outputs: [],
      steps: [
        { id: 'submit-search', type: 'click', target: searchButtonTarget(), risk, execution },
      ],
    };
  };

  it('does not repeat a step that succeeded first time', async () => {
    const surface = workingSurface();

    const result = await engineWith(surface).run(
      artifact(clickArtifact({ retry: { maxAttempts: 3 } })),
      {},
    );

    expect(result.status).toBe('success');
    expect(result.completedSteps[0]?.attempts).toBe(1);
  });

  it('repeats the identical action and succeeds on the second attempt', async () => {
    let attempts = 0;
    const surface = new FakeSurface({
      click: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TargetNotFoundError('Search Button', []);
        }
      },
    });

    const result = await engineWith(surface).run(
      artifact(clickArtifact({ retry: { maxAttempts: 2 } })),
      {},
    );

    expect(result.status).toBe('success');
    expect(result.completedSteps[0]?.attempts).toBe(2);
    expect(surface.calls.filter((call) => call.method === 'click')).toHaveLength(2);
  });

  it('stops at the declared maximum instead of retrying without a bound', async () => {
    let attempts = 0;
    const surface = new FakeSurface({
      click: () => {
        attempts += 1;
        throw new TargetNotFoundError('Search Button', []);
      },
    });

    const result = await engineWith(surface).run(
      artifact(clickArtifact({ retry: { maxAttempts: 3 } })),
      {},
    );

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.attempts).toBe(3);
    expect(attempts).toBe(3);
  });

  it('does not repeat a step the artifact flagged as changing the application', async () => {
    let attempts = 0;
    const surface = new FakeSurface({
      click: () => {
        attempts += 1;
        throw new TargetNotFoundError('Search Button', []);
      },
    });

    const result = await engineWith(surface).run(
      artifact(clickArtifact({ retry: { maxAttempts: 3 } }, 'risky')),
      {},
    );

    expect(result.status).toBe('failure');
    expect(attempts).toBe(1);
  });

  it('says so in the log when it suppresses a declared retry', async () => {
    const { logger, records } = recordingLogger();
    const engine = new ReplayEngine({
      surface: new FakeSurface(),
      logger,
      timeouts: TEST_TIMEOUTS,
    });

    await engine.run(artifact(clickArtifact({ retry: { maxAttempts: 3 } }, 'risky')), {});

    const warning = records().find((record) => record['message'] === 'Retry Not Applied');
    expect(warning?.['stepId']).toBe('submit-search');
    expect(warning?.['risk']).toBe('risky');
  });
});

describe('budgets', () => {
  it('hands the declared step timeout to the surface', async () => {
    const surface = workingSurface();

    await engineWith(surface).run(
      artifact({
        inputs: [],
        outputs: [],
        steps: [
          {
            id: 'await-summary',
            type: 'wait',
            condition: { type: 'targetVisible', target: summaryTarget() },
            execution: { timeoutMs: 4321 },
          },
        ],
      }),
      {},
    );

    expect(surface.calls[0]?.timeoutMs).toBe(4321);
  });

  it('falls back to the surface budget for a step that declares none', async () => {
    const surface = workingSurface();

    await engineWith(surface).run(
      artifact({
        inputs: [],
        outputs: [],
        steps: [
          { id: 'open-lookup', type: 'navigate', url: 'https://demo.replay-ai.test/members' },
        ],
      }),
      {},
    );

    expect(surface.calls[0]?.timeoutMs).toBe(TEST_TIMEOUTS.navigationMs);
  });

  it('gives up on a surface that never answers instead of hanging', async () => {
    const result = await engineWith(new HangingSurface(), { stepTimeoutMs: 60 }).run(
      artifact({
        inputs: [],
        outputs: [],
        steps: [
          { id: 'open-lookup', type: 'navigate', url: 'https://demo.replay-ai.test/members' },
        ],
      }),
      {},
    );

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_STEP_TIMEOUT');
    expect(result.stepId).toBe('open-lookup');
    expect(result.expected).toContain('60ms');
  });

  it('bounds a checkpoint that never answers', async () => {
    const result = await engineWith(new HangingSurface(), { stepTimeoutMs: 60 }).run(
      artifact({
        inputs: [],
        outputs: [],
        steps: [
          {
            id: 'await-summary',
            type: 'wait',
            condition: { type: 'targetVisible', target: summaryTarget() },
          },
        ],
      }),
      {},
    );

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_STEP_TIMEOUT');
  });
});

describe('logging', () => {
  it('records the run without ever writing the value it typed', async () => {
    const { logger, records } = recordingLogger();
    const engine = new ReplayEngine({
      surface: workingSurface(),
      logger,
      timeouts: TEST_TIMEOUTS,
    });

    await engine.run(fullArtifact(), { memberId: 'SECRET-REFERENCE' });

    const messages = records().map((record) => record['message']);
    expect(messages).toContain('Replay Started');
    expect(messages).toContain('Step Started');
    expect(messages).toContain('Step Completed');
    expect(messages).toContain('Checkpoint Passed');
    expect(messages).toContain('Replay Completed');
    expect(JSON.stringify(records())).not.toContain('SECRET-REFERENCE');
  });

  it('records a failed checkpoint with what it expected and what it saw', async () => {
    const { logger, records } = recordingLogger();
    const engine = new ReplayEngine({
      surface: new FakeSurface({ waitFor: () => false }),
      logger,
      timeouts: TEST_TIMEOUTS,
    });

    await engine.run(
      artifact({
        inputs: [],
        outputs: [],
        steps: [
          {
            id: 'confirm-screen',
            type: 'checkpoint',
            condition: { type: 'targetVisible', target: memberIdTarget() },
          },
        ],
      }),
      {},
    );

    const failed = records().find((record) => record['message'] === 'Checkpoint Failed');
    expect(failed?.['expected']).toBe('Target "Member ID Field" Is Visible');
    expect(failed?.['observed']).toBe('Not Visible');
  });
});

describe('outputs', () => {
  it('returns only what the capability declares', async () => {
    const surface = workingSurface();

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '12345' });

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(Object.keys(result.outputs)).toEqual(['savingsBalance']);
  });

  it('fails clearly when a value cannot be read as the declared type', async () => {
    const surface = new FakeSurface({ extract: () => '$1,024.50' });

    const result = await engineWith(surface).run(fullArtifact(), { memberId: '24680' });

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_OUTPUT_TYPE_MISMATCH');
    expect(result.stepId).toBe('read-balance');
    expect(result.observed).toBe('$1,024.50');
  });

  it('reads a string output as the text on the screen, with layout whitespace removed', async () => {
    const surface = new FakeSurface({ extract: () => '  Ada Lovelace\n' });

    const result = await engineWith(surface).run(
      artifact({
        inputs: [],
        outputs: [{ name: 'memberName', type: 'string', description: 'The member name.' }],
        steps: [
          { id: 'read-name', type: 'extract', target: balanceTarget(), output: 'memberName' },
        ],
      }),
      {},
    );

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(result.outputs).toEqual({ memberName: 'Ada Lovelace' });
  });
});
