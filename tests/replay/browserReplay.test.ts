import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  deserializeCapabilityArtifact,
  parseCapabilityArtifact,
  type CapabilityArtifact,
} from '../../src/artifacts/index.js';
import { ReplayEngine, type ReplayResult } from '../../src/replay/index.js';
import type { ComputerSurface } from '../../src/surfaces/index.js';
import type { PlaywrightSession } from '../../src/surfaces/playwright/index.js';
import { openSurface, TEST_TIMEOUTS } from '../surfaces/support/fixture.js';

import { silentLogger } from './support/artifacts.js';
import { permissivePolicy } from './support/policy.js';

/**
 * The Phase 4 proof, and the only suite here that touches a browser.
 *
 * A capability artifact that is committed to this repository is loaded through the real
 * Phase 3 validator, handed to the replay engine, and executed against a local HTML
 * fixture through `ComputerSurface` and its Playwright implementation:
 *
 * ```text
 * capabilities/examples/lookup-demo-member.json
 *   -> ReplayEngine -> StepExecutor -> ComputerSurface -> PlaywrightSurface -> the page
 * ```
 *
 * Nothing in that chain calls a model, and nothing in it reaches the network: the
 * fixture is a file on disk. The artifact names a demo host it was authored against, so
 * the only thing the suite changes is where the workflow starts.
 */

const ARTIFACT_PATH = 'capabilities/examples/lookup-demo-member.json';

const FIXTURE_URL = pathToFileURL(resolve('tests/fixtures/member-lookup.html')).href;

/**
 * Points the committed artifact at the local fixture.
 *
 * The steps, targets, checkpoints, inputs, outputs, and success condition are the
 * committed ones, so this suite exercises the artifact a reviewer reads rather than a
 * copy of it written to pass. Re-validated afterwards, because an artifact the engine
 * runs is always one the validator accepted.
 */
function atLocalFixture(artifact: CapabilityArtifact, overrides: object = {}): CapabilityArtifact {
  const steps = artifact.steps.map((step) => {
    if (step.type !== 'navigate') {
      return step;
    }
    return { ...step, url: FIXTURE_URL };
  });

  return parseCapabilityArtifact({
    ...artifact,
    application: { ...artifact.application, entryPoint: FIXTURE_URL },
    steps,
    ...overrides,
  });
}

function committedArtifact(): CapabilityArtifact {
  return deserializeCapabilityArtifact(readFileSync(ARTIFACT_PATH, 'utf8'), {
    source: ARTIFACT_PATH,
  });
}

let surface: ComputerSurface;
let session: PlaywrightSession;

beforeAll(async () => {
  const fixture = await openSurface();
  surface = fixture.surface;
  session = fixture.session;
});

afterAll(async () => {
  await session.close();
});

async function replay(artifact: CapabilityArtifact, memberId: string): Promise<ReplayResult> {
  const engine = new ReplayEngine({
    surface,
    logger: silentLogger(),
    policy: permissivePolicy(),
    timeouts: TEST_TIMEOUTS,
  });
  return await engine.run(artifact, { memberId });
}

describe('replaying a committed capability artifact against a real browser', () => {
  it('runs the whole workflow and returns the declared outputs', async () => {
    const result = await replay(atLocalFixture(committedArtifact()), '12345');

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(result.outputs).toEqual({ memberName: 'Ada Lovelace', savingsBalance: 5234.17 });
    expect(result.completedSteps.map((step) => step.stepId)).toEqual([
      'open-member-lookup',
      'confirm-lookup-screen',
      'enter-member-id',
      'submit-member-search',
      'await-member-summary',
      'read-member-name',
      'read-savings-balance',
    ]);
  });

  it('changes what it reads when the invocation input changes', async () => {
    const result = await replay(atLocalFixture(committedArtifact()), '67890');

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(result.outputs).toEqual({ memberName: 'Grace Hopper', savingsBalance: 118.05 });
  });

  it('reports a declared business outcome rather than a broken automation', async () => {
    const result = await replay(atLocalFixture(committedArtifact()), '00000');

    expect(result.status).toBe('businessOutcome');
    if (result.status !== 'businessOutcome') {
      return;
    }
    expect(result.code).toBe('MEMBER_NOT_FOUND');
    expect(result.stepId).toBe('await-member-summary');
    // The artifact gives the summary five seconds to appear, and an unknown member
    // spends all of it before the outcome is detected, so this case needs a longer
    // budget than the suite default.
  }, 20_000);

  it('refuses a value it cannot read as the declared output type', async () => {
    const result = await replay(atLocalFixture(committedArtifact()), '24680');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_OUTPUT_TYPE_MISMATCH');
    expect(result.stepId).toBe('read-savings-balance');
    expect(result.observed).toBe('$1,024.50');
  });

  it('fails when the success condition does not hold, even though every step ran', async () => {
    const artifact = atLocalFixture(committedArtifact(), {
      successCondition: {
        type: 'targetVisible',
        target: {
          description: 'Closed Account Banner',
          strategies: [{ kind: 'attribute', attribute: 'data-testid', value: 'closed-banner' }],
        },
      },
    });

    const result = await replay(artifact, '12345');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_SUCCESS_CONDITION_FAILED');
    expect(result.expected).toBe('Target "Closed Account Banner" Is Visible');
    expect(result.observed).toBe('Not Visible');
    expect(result.completedSteps).toHaveLength(7);
  });

  it('fails when a checkpoint step asserts a state the page never reaches', async () => {
    const artifact = atLocalFixture(committedArtifact(), {
      steps: [
        { id: 'open-member-lookup', type: 'navigate', url: FIXTURE_URL, risk: 'safe' },
        {
          id: 'confirm-lookup-screen',
          type: 'checkpoint',
          condition: { type: 'textVisible', text: 'Corporate Member Lookup' },
        },
        ...committedArtifact().steps.slice(2),
      ],
    });

    const result = await replay(artifact, '12345');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_CHECKPOINT_FAILED');
    expect(result.stepId).toBe('confirm-lookup-screen');
    expect(result.expected).toBe('Text "Corporate Member Lookup" Is Visible');
  });
});
