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
 * The Phase 5 proof: every runtime condition, driven through a real browser.
 *
 * The committed `lookup-demo-member` artifact declares the states the demo console can
 * answer with and the interstitials it knows how to clear. The fixture reaches each of
 * them from one member id, so a case here reads as "search for this, get that", and
 * every scenario is deterministic: the console counts attempts rather than watching a
 * clock.
 *
 * ```text
 * 12345  normal success        77777  known dialog, recovered
 * 00000  business outcome      88888  request did not land, recovered
 * 99999  permission denied     44444  known dialog that never clears
 * 55555  session expired       66666  an interstitial nothing declares
 * 24680  unreadable output
 * ```
 */

const ARTIFACT_PATH = 'tests/fixtures/capabilities/lookup-demo-member.json';

const FIXTURE_URL = pathToFileURL(resolve('tests/fixtures/member-lookup.html')).href;

function atLocalFixture(artifact: CapabilityArtifact): CapabilityArtifact {
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
  });
}

function committedArtifact(): CapabilityArtifact {
  return atLocalFixture(
    deserializeCapabilityArtifact(readFileSync(ARTIFACT_PATH, 'utf8'), { source: ARTIFACT_PATH }),
  );
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

async function lookUp(memberId: string): Promise<ReplayResult> {
  const engine = new ReplayEngine({
    surface,
    logger: silentLogger(),
    policy: permissivePolicy(),
    timeouts: TEST_TIMEOUTS,
  });
  return await engine.run(committedArtifact(), { memberId });
}

describe('the happy path', () => {
  it('still works exactly as it did, and reports no recoveries', async () => {
    const result = await lookUp('12345');

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(result.outputs).toEqual({ memberName: 'Ada Lovelace', savingsBalance: 5234.17 });
    expect(result.recoveries).toEqual([]);
    expect(result.completedSteps).toHaveLength(7);
  });
});

describe('a business outcome', () => {
  it('reports "no member matches" as an answer, not a crash', async () => {
    const result = await lookUp('00000');

    expect(result.status).toBe('businessOutcome');
    if (result.status !== 'businessOutcome') {
      return;
    }
    expect(result.code).toBe('MEMBER_NOT_FOUND');
    expect(result.message).toContain('no member matches');
    expect(result.stepId).toBe('await-member-summary');
  }, 20_000);
});

describe('a declared state that stops the run', () => {
  it('reports a permission denial with the declared code', async () => {
    const result = await lookUp('99999');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.kind).toBe('terminal');
    expect(result.message).toContain('not permitted');
  }, 20_000);

  it('reports an expired session, which it has no safe way to repair', async () => {
    const result = await lookUp('55555');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('SESSION_EXPIRED');
    expect(result.kind).toBe('terminal');
  }, 20_000);
});

describe('a recoverable condition', () => {
  it('acknowledges the session warning it knows and completes the workflow', async () => {
    const result = await lookUp('77777');

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(result.outputs).toEqual({ memberName: 'Katherine Johnson', savingsBalance: 9310 });
    expect(result.recoveries).toEqual([
      expect.objectContaining({
        code: 'KNOWN_SESSION_DIALOG',
        stepId: 'await-member-summary',
        attempt: 1,
        succeeded: true,
      }),
    ]);
  }, 20_000);

  it('runs the request again when the console says it did not land', async () => {
    const result = await lookUp('88888');

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    expect(result.outputs).toEqual({ memberName: 'Radia Perlman', savingsBalance: 640.25 });
    expect(result.recoveries.map((record) => record.code)).toEqual(['TRANSIENT_LOAD']);
  }, 20_000);

  it('gives up at the declared bound when the state keeps coming back', async () => {
    const result = await lookUp('44444');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_RECOVERY_EXHAUSTED');
    expect(result.kind).toBe('recoveryExhausted');
    expect(result.stepId).toBe('await-member-summary');
    expect(result.recoveries).toHaveLength(2);
  }, 30_000);
});

describe('an interstitial nothing declares', () => {
  it('stops rather than pressing a button it was never told about', async () => {
    const result = await lookUp('66666');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_WAIT_TIMEOUT');
    expect(result.kind).toBe('terminal');
    expect(result.recoveries).toEqual([]);
    expect(result.expected).toBe('Target "Member Summary Region" Is Visible');
  }, 20_000);

  it('leaves the unknown dialog on screen, unapproved', async () => {
    await lookUp('66666');

    const observation = await surface.observe();
    expect(observation.textSummary).toContain('Confirm Unusual Activity');
    expect(observation.textSummary).not.toContain('Approved');
  }, 20_000);
});

describe('an output the declared type cannot hold', () => {
  it('fails rather than guessing a number out of a formatted string', async () => {
    const result = await lookUp('24680');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.code).toBe('REPLAY_OUTPUT_TYPE_MISMATCH');
    expect(result.kind).toBe('terminal');
    expect(result.observed).toBe('$1,024.50');
  }, 20_000);
});

describe('every failure returned from a real browser', () => {
  it('carries a stable code and useful context, and no browser exception', async () => {
    const result = await lookUp('66666');

    expect(result.status).toBe('failure');
    if (result.status !== 'failure') {
      return;
    }
    expect(result.capabilityId).toBe('lookup-demo-member');
    expect(result.capabilityVersion).toBe(2);
    expect(result.stepType).toBe('wait');
    expect(result.observed).toBe('Not Visible');

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Call log');
    expect(serialized).not.toContain('playwright');
    expect(serialized).not.toContain('    at ');
  }, 20_000);
});
