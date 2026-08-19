import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileArtifactStore } from '../../src/artifacts/index.js';
import { ArtifactCompiler, type CompilationRequest } from '../../src/compilation/index.js';
import { StaticPolicyEngine } from '../../src/policy/index.js';
import { silentLogger } from '../discovery/support/fakes.js';
import { FakeSurface, type FakeBehavior } from '../replay/support/fakeSurface.js';

import { memberLookupTrace } from './support/traces.js';

/**
 * The gate between a compiled artifact and a saved one.
 *
 * A capability is accepted because it replayed, not because it compiled. These suites
 * drive the real replay engine and the real policy engine against a scripted surface, so
 * what is being tested is the acceptance rule rather than a browser.
 */

const REQUEST: CompilationRequest = {
  id: 'lookup-member-balance',
  name: 'Lookup Member Balance',
  description: 'Looks up a member by reference and reads their savings balance.',
};

let capabilitiesDir: string;

beforeEach(async () => {
  capabilitiesDir = await mkdtemp(join(tmpdir(), 'replay-ai-capabilities-'));
});

afterEach(async () => {
  await rm(capabilitiesDir, { recursive: true, force: true });
});

/** The policy a deployment running this workflow would have. Never a permissive stub. */
function policy(): StaticPolicyEngine {
  return new StaticPolicyEngine({
    allowedHosts: ['demo.replay-ai.test'],
    allowedSchemes: ['https'],
    allowedRoutes: [],
    allowedActions: ['navigate', 'click', 'fill', 'extract', 'wait', 'checkpoint'],
    riskPolicy: { safe: 'allow', risky: 'requireConfirmation', irreversible: 'block' },
  });
}

function compilerWith(behavior: FakeBehavior = {}, engine = policy()): ArtifactCompiler {
  return new ArtifactCompiler({
    surface: new FakeSurface({ url: 'https://demo.replay-ai.test/members', ...behavior }),
    policy: engine,
    store: new FileArtifactStore({ directory: capabilitiesDir }),
    logger: silentLogger(),
    now: () => new Date('2026-08-19T10:00:00.000Z'),
    verificationRunId: '44444444-4444-4444-8444-444444444444',
  });
}

const WORKING_SURFACE: FakeBehavior = { extract: () => '5234.17' };

describe('a capability that replays', () => {
  it('is compiled, validated, replayed, and only then saved', async () => {
    const compiler = compilerWith(WORKING_SURFACE);

    const result = await compiler.compile(memberLookupTrace(), REQUEST);

    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') {
      return;
    }
    expect(result.sourceDiscoveryRunId).toBe('33333333-3333-4333-8333-333333333333');
    expect(result.verificationReplayRunId).toBe('44444444-4444-4444-8444-444444444444');
    expect(await readdir(capabilitiesDir)).toEqual(['lookup-member-balance.json']);
  });

  it('replays with the values the discovery run used', async () => {
    const surface = new FakeSurface({
      url: 'https://demo.replay-ai.test/members',
      extract: () => '5234.17',
    });
    const compiler = new ArtifactCompiler({
      surface,
      policy: policy(),
      store: new FileArtifactStore({ directory: capabilitiesDir }),
      logger: silentLogger(),
    });

    await compiler.compile(memberLookupTrace(), REQUEST);

    // The parameter resolved back to the value discovery typed, which is what proves the
    // artifact is executable rather than merely well-formed.
    expect(surface.fills).toEqual([{ target: 'Member ID Field', value: '12345' }]);
  });

  it('writes a file a reviewer can read, with no discovered value in it', async () => {
    const result = await compilerWith(WORKING_SURFACE).compile(memberLookupTrace(), REQUEST);

    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') {
      return;
    }
    const written = await readFile(result.artifactPath, 'utf8');

    expect(written).toContain('"name": "Lookup Member Balance"');
    expect(written).toContain('"source": "input"');
    expect(written).not.toContain('12345');
    expect(written).not.toContain('5234.17');
  });
});

describe('a capability that does not replay', () => {
  it('is rejected and never saved', async () => {
    // The workflow's wait never lands, which is what a discovered step that does not
    // generalize looks like at replay time.
    const compiler = compilerWith({ waitFor: () => false });

    const result = await compiler.compile(memberLookupTrace(), REQUEST);

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      return;
    }
    expect(result.stage).toBe('verification');
    expect(result.code).toBe('VERIFICATION_REPLAY_FAILED');
    // The artifact is returned so it can be inspected, and written nowhere.
    expect(result.capability?.id).toBe('lookup-member-balance');
    expect(await readdir(capabilitiesDir)).toEqual([]);
  });

  it('is rejected when it reads something other than what the run read', async () => {
    // The failure this catches is the quiet one. Every step succeeds, the success
    // condition holds, and the extract step resolves to the heading above the value
    // instead of the value, so the capability returns "Member Summary" as a balance.
    const compiler = compilerWith({ extract: () => 'Member Summary' });

    const result = await compiler.compile(memberLookupTrace(), REQUEST);

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      return;
    }
    expect(result.stage).toBe('verification');
    expect(result.message).toContain('savingsBalance');
    // Neither the expected nor the actual value is repeated into the message.
    expect(result.message).not.toContain('5234.17');
    expect(await readdir(capabilitiesDir)).toEqual([]);
  });

  it('accepts a value that differs only in how it is formatted', async () => {
    // Discovery reported 5234.17 and the application renders $5,234.17. That is the same
    // balance, and failing the capability over a currency symbol would be wrong.
    const compiler = compilerWith({ extract: () => '$5,234.17' });

    const result = await compiler.compile(memberLookupTrace(), REQUEST);

    expect(result.status).toBe('compiled');
  });

  it('is rejected when a control cannot be operated', async () => {
    const compiler = compilerWith({
      click: (): never => {
        throw new Error('the control was not there');
      },
    });

    const result = await compiler.compile(memberLookupTrace(), REQUEST);

    expect(result.status).toBe('rejected');
    expect(await readdir(capabilitiesDir)).toEqual([]);
  });
});

describe('policy during verification', () => {
  it('applies to a verification replay exactly as it applies to any other run', async () => {
    // A capability that came from a successful discovery has earned nothing. The guardrail
    // is asked the same question it would be asked in production.
    const readOnly = new StaticPolicyEngine({
      allowedHosts: ['demo.replay-ai.test'],
      allowedSchemes: ['https'],
      allowedRoutes: [],
      allowedActions: ['navigate', 'extract', 'wait', 'checkpoint'],
      riskPolicy: { safe: 'allow', risky: 'block', irreversible: 'block' },
    });

    const surface = new FakeSurface({ url: 'https://demo.replay-ai.test/members' });
    const compiler = new ArtifactCompiler({
      surface,
      policy: readOnly,
      store: new FileArtifactStore({ directory: capabilitiesDir }),
      logger: silentLogger(),
    });

    const result = await compiler.compile(memberLookupTrace(), REQUEST);

    expect(result.status).toBe('rejected');
    // The fill the policy forbids never reached the surface.
    expect(surface.methods()).not.toContain('fill');
    expect(await readdir(capabilitiesDir)).toEqual([]);
  });
});

describe('an id that is already taken', () => {
  it('is refused rather than overwritten', async () => {
    await compilerWith(WORKING_SURFACE).compile(memberLookupTrace(), REQUEST);
    const before = await readFile(join(capabilitiesDir, 'lookup-member-balance.json'), 'utf8');

    const second = await compilerWith(WORKING_SURFACE).compile(memberLookupTrace(), {
      ...REQUEST,
      description: 'A different description entirely.',
    });

    expect(second.status).toBe('rejected');
    if (second.status !== 'rejected') {
      return;
    }
    expect(second.stage).toBe('persistence');
    expect(second.message).toContain('already exists');
    expect(await readFile(join(capabilitiesDir, 'lookup-member-balance.json'), 'utf8')).toBe(
      before,
    );
  });

  it('is replaced when a caller asks for it explicitly', async () => {
    await compilerWith(WORKING_SURFACE).compile(memberLookupTrace(), REQUEST);

    const second = await compilerWith(WORKING_SURFACE).compile(memberLookupTrace(), {
      ...REQUEST,
      description: 'A different description entirely.',
      overwrite: true,
    });

    expect(second.status).toBe('compiled');
    const written = await readFile(join(capabilitiesDir, 'lookup-member-balance.json'), 'utf8');
    expect(written).toContain('A different description entirely.');
  });

  it('cannot be talked into writing outside the capabilities directory', async () => {
    const result = await compilerWith(WORKING_SURFACE).compile(memberLookupTrace(), {
      ...REQUEST,
      id: '../escaped',
    });

    // The id rule the store and the schema share is what stops this, and it stops it at
    // validation rather than at the filesystem.
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      return;
    }
    expect(result.stage).toBe('validation');
    expect(await readdir(capabilitiesDir)).toEqual([]);
  });
});

describe('a trace that cannot become a workflow', () => {
  it('is rejected at the stage that could not do it, having written nothing', async () => {
    const result = await compilerWith(WORKING_SURFACE).compile(
      memberLookupTrace({ inputs: [{ name: 'branchCode', value: 'BR-9' }] }),
      REQUEST,
    );

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      return;
    }
    expect(result.stage).toBe('parameterization');
    expect(result.code).toBe('PARAMETERIZATION_FAILED');
    expect(result.verificationReplayRunId).toBeUndefined();
    expect(await readdir(capabilitiesDir)).toEqual([]);
  });
});
