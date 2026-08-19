import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FileArtifactStore } from '../../src/artifacts/index.js';
import { ArtifactCompiler, type CompilationRequest } from '../../src/compilation/index.js';
import { ReplayEngine } from '../../src/replay/index.js';
import type { ComputerSurface } from '../../src/surfaces/index.js';
import type { PlaywrightSession } from '../../src/surfaces/playwright/index.js';
import { silentLogger } from '../discovery/support/fakes.js';
import { permissivePolicy } from '../replay/support/policy.js';
import { openSurface, TEST_TIMEOUTS } from '../surfaces/support/fixture.js';

import { memberLookupTrace } from './support/traces.js';

/**
 * The Phase 8 proof, and the chain the whole project exists to demonstrate.
 *
 * ```text
 * discovery trace -> ArtifactCompiler -> capability artifact -> validation
 *   -> ReplayEngine -> ComputerSurface -> PlaywrightSurface -> the real page
 * ```
 *
 * The trace is a fixture rather than a live run, so this suite needs no model and no
 * network. Everything after it is the production path: the real compiler, the real
 * validator, the real replay engine, the real policy engine, and a real browser driving
 * the demo console.
 *
 * The last case is the one that matters most. It replays the saved capability with a
 * member the discovery run never saw, which is the difference between a reusable
 * capability and an expensive recording of one lookup.
 */

const FIXTURE_URL = pathToFileURL(resolve('tests/fixtures/member-lookup.html')).href;

const REQUEST: CompilationRequest = {
  id: 'lookup-member-balance',
  name: 'Lookup Member Balance',
  description: 'Looks up a demo member by reference and reads their savings balance.',
  businessOutcomes: [
    {
      code: 'MEMBER_NOT_FOUND',
      description: 'The demo console reports that no member matches the supplied reference.',
      condition: { type: 'textVisible', text: 'No Member Matches That Reference' },
      disposition: 'businessOutcome',
    },
  ],
};

let session: PlaywrightSession;
let surface: ComputerSurface;
let capabilitiesDir: string;

beforeAll(async () => {
  const fixture = await openSurface();
  session = fixture.session;
  surface = fixture.surface;
}, 60_000);

afterAll(async () => {
  await session.close();
});

beforeEach(async () => {
  capabilitiesDir = await mkdtemp(join(tmpdir(), 'replay-ai-e2e-'));
});

afterEach(async () => {
  await rm(capabilitiesDir, { recursive: true, force: true });
});

function compiler(): ArtifactCompiler {
  return new ArtifactCompiler({
    surface,
    policy: permissivePolicy(),
    store: new FileArtifactStore({ directory: capabilitiesDir }),
    logger: silentLogger(),
    timeouts: TEST_TIMEOUTS,
  });
}

/** The run as discovery would have recorded it against the local fixture. */
function trace(): ReturnType<typeof memberLookupTrace> {
  return memberLookupTrace({ entryPoint: FIXTURE_URL });
}

describe('a discovery trace becoming a working capability', () => {
  it('compiles, validates, replays against the real page, and is saved', async () => {
    const result = await compiler().compile(trace(), REQUEST);

    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') {
      return;
    }

    // Saved only because the artifact actually drove the browser through the workflow.
    expect(result.artifactPath).toBe(join(capabilitiesDir, 'lookup-member-balance.json'));
    expect(result.verificationReplayRunId).not.toBe(result.sourceDiscoveryRunId);
  }, 60_000);

  it('produces an artifact that replays for a member the discovery run never saw', async () => {
    const compiled = await compiler().compile(trace(), REQUEST);
    expect(compiled.status).toBe('compiled');

    // Loaded back off the disk through the full validation path, exactly as the replay
    // command loads one.
    const store = new FileArtifactStore({ directory: capabilitiesDir });
    const capability = await store.load('lookup-member-balance');

    const engine = new ReplayEngine({
      surface,
      logger: silentLogger(),
      policy: permissivePolicy(),
      timeouts: TEST_TIMEOUTS,
    });

    const result = await engine.run(capability, { memberId: '67890' });

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }
    // Grace Hopper's balance, which appears nowhere in the trace, the artifact, or this
    // test's inputs. The capability read it from the application.
    expect(result.outputs).toEqual({ savingsBalance: '118.05' });
  }, 60_000);

  it('answers with the declared business outcome for a member that does not exist', async () => {
    await compiler().compile(trace(), REQUEST);
    const store = new FileArtifactStore({ directory: capabilitiesDir });
    const capability = await store.load('lookup-member-balance');

    const engine = new ReplayEngine({
      surface,
      logger: silentLogger(),
      policy: permissivePolicy(),
      timeouts: TEST_TIMEOUTS,
    });

    const result = await engine.run(capability, { memberId: '00000' });

    // A known answer from the application, not a broken automation.
    expect(result.status).toBe('businessOutcome');
    if (result.status !== 'businessOutcome') {
      return;
    }
    expect(result.code).toBe('MEMBER_NOT_FOUND');
  }, 60_000);
});
