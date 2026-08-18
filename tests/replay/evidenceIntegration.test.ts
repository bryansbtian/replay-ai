import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileEvidenceRecorder } from '../../src/evidence/index.js';
import { DEFAULT_POLICY, summarizePolicy } from '../../src/policy/index.js';
import { ReplayEngine, type ReplayResult } from '../../src/replay/index.js';
import type { ComputerSurface } from '../../src/surfaces/index.js';

import {
  declaredStates,
  fullArtifact,
  silentLogger,
  TEST_TIMEOUTS,
  type JsonObject,
} from './support/artifacts.js';
import { FakeSurface } from './support/fakeSurface.js';
import { permissivePolicy, policyFrom } from './support/policy.js';

/**
 * What a run leaves behind, produced by an actual run rather than by calling the
 * recorder directly.
 *
 * The scripted surface keeps the cases exact and fast; the screenshot path is exercised
 * here too, because a recorder that is only ever driven by its own unit tests is a
 * recorder nobody has proved the engine reaches.
 */

const RUN_ID = '99999999-8888-4777-8666-555555555555';

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'replay-ai-run-'));
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

function recorder(): FileEvidenceRecorder {
  return new FileEvidenceRecorder({ evidenceDir, runId: RUN_ID });
}

/** Runs a capability the way the command does: start, run, complete. */
async function replay(
  surface: ComputerSurface,
  overrides: JsonObject = {},
  policy = permissivePolicy(),
): Promise<{ result: ReplayResult; evidence: FileEvidenceRecorder }> {
  const artifact = fullArtifact(overrides);
  const evidence = recorder();

  await evidence.start({
    runId: RUN_ID,
    capabilityId: artifact.id,
    capabilityVersion: artifact.version,
    capabilityName: artifact.name,
    inputNames: artifact.inputs.map((input) => input.name),
    policy: summarizePolicy(DEFAULT_POLICY),
  });

  const engine = new ReplayEngine({
    surface,
    logger: silentLogger(),
    policy,
    evidence,
    timeouts: TEST_TIMEOUTS,
    replayId: RUN_ID,
  });
  const result = await engine.run(artifact, { memberId: '12345' });

  await evidence.complete({
    status: result.status,
    durationMs: result.durationMs,
    completedSteps: result.completedSteps.length,
    recoveries: result.recoveries.length,
  });
  return { result, evidence };
}

async function eventsOf(evidence: FileEvidenceRecorder): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(evidence.directory, 'events.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function namesOf(evidence: FileEvidenceRecorder): Promise<string[]> {
  const events = await eventsOf(evidence);
  return events.map((event) => String(event['event']));
}

function workingSurface(): FakeSurface {
  return new FakeSurface({ extract: () => '5234.17' });
}

describe('a successful run', () => {
  it('records the run from start to finish', async () => {
    const { result, evidence } = await replay(workingSurface());

    expect(result.status).toBe('success');
    const names = await namesOf(evidence);
    expect(names[0]).toBe('run_started');
    expect(names.at(-1)).toBe('run_completed');
    expect(names).toContain('step_started');
    expect(names).toContain('step_completed');
    expect(names).toContain('checkpoint_passed');
  });

  it('records that every action was evaluated by policy', async () => {
    const { evidence } = await replay(workingSurface());

    const evaluated = (await eventsOf(evidence)).filter(
      (event) => event['event'] === 'policy_evaluated',
    );
    // One per step, so "was this allowed?" has an answer for each of them.
    expect(evaluated).toHaveLength(fullArtifact().steps.length);
    expect(evaluated.every((event) => event['outcome'] === 'allow')).toBe(true);
  });

  it('takes no screenshot, because nothing went wrong', async () => {
    const { evidence } = await replay(workingSurface());

    expect(await readdir(join(evidence.directory, 'screenshots'))).toEqual([]);
  });

  it('never persists the value that was typed', async () => {
    const surface = workingSurface();
    const artifact = fullArtifact();
    const evidence = recorder();
    await evidence.start({
      runId: RUN_ID,
      capabilityId: artifact.id,
      capabilityVersion: artifact.version,
      capabilityName: artifact.name,
      inputNames: ['memberId'],
      policy: summarizePolicy(DEFAULT_POLICY),
    });
    const engine = new ReplayEngine({
      surface,
      logger: silentLogger(),
      policy: permissivePolicy(),
      evidence,
      timeouts: TEST_TIMEOUTS,
      replayId: RUN_ID,
    });

    await engine.run(artifact, { memberId: 'SECRET-MEMBER-REFERENCE' });
    await evidence.complete({
      status: 'success',
      durationMs: 1,
      completedSteps: 6,
      recoveries: 0,
    });

    // The surface was given the value, and the record was not.
    expect(surface.fills[0]?.value).toBe('SECRET-MEMBER-REFERENCE');
    const written = [
      await readFile(join(evidence.directory, 'events.jsonl'), 'utf8'),
      await readFile(join(evidence.directory, 'metadata.json'), 'utf8'),
    ].join('');
    expect(written).not.toContain('SECRET-MEMBER-REFERENCE');
    expect(written).toContain('memberId');
  });
});

describe('a business outcome', () => {
  it('is recorded as an outcome and finalized as one', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      waitFor: (condition) => {
        if (condition.type === 'textVisible') {
          return condition.text === 'No Member Matches That Reference';
        }
        return false;
      },
    });

    const { result, evidence } = await replay(surface, declaredStates());

    expect(result.status).toBe('businessOutcome');
    expect(await namesOf(evidence)).toContain('business_outcome_detected');
    const metadata = JSON.parse(
      await readFile(join(evidence.directory, 'metadata.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(metadata['status']).toBe('businessOutcome');
  });
});

describe('a hard failure', () => {
  it('captures a screenshot named after what went wrong', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      waitFor: (condition) => condition.type !== 'targetVisible',
    });

    const { result, evidence } = await replay(surface);

    expect(result.status).toBe('failure');
    const shots = await readdir(join(evidence.directory, 'screenshots'));
    expect(shots).toEqual(['001-replay-wait-timeout.png']);
    expect(await namesOf(evidence)).toContain('screenshot_captured');
  });

  it('records what was expected and what was observed', async () => {
    const surface = new FakeSurface({
      extract: () => '5234.17',
      waitFor: (condition) => condition.type !== 'targetVisible',
    });

    const { evidence } = await replay(surface);

    const failed = (await eventsOf(evidence)).find((event) => event['event'] === 'step_failed');
    expect(failed).toMatchObject({
      stepId: 'await-summary',
      stepType: 'wait',
      code: 'REPLAY_WAIT_TIMEOUT',
      expected: 'Target "Member Summary Region" Is Visible',
    });
  });
});

describe('a policy block', () => {
  it('records the denial, its reason, and nothing the action would have carried', async () => {
    const elsewhere = policyFrom({ allowedHosts: ['other.example'], allowedSchemes: ['https'] });
    const surface = workingSurface();

    const { result, evidence } = await replay(surface, {}, elsewhere);

    expect(result.status).toBe('failure');
    const blocked = (await eventsOf(evidence)).find((event) => event['event'] === 'policy_blocked');
    expect(blocked).toMatchObject({
      stepId: 'open-lookup',
      code: 'POLICY_DOMAIN_NOT_ALLOWED',
      reason: 'The Destination Host Is Not On The Allowlist',
    });
    // The only thing the surface was asked for is the frame the operator will look at.
    expect(surface.methods()).toEqual(['screenshot']);
  });

  it('captures the screen the operator would want to see', async () => {
    const elsewhere = policyFrom({ allowedHosts: ['other.example'], allowedSchemes: ['https'] });

    const { evidence } = await replay(workingSurface(), {}, elsewhere);

    expect(await readdir(join(evidence.directory, 'screenshots'))).toEqual([
      '001-policy-domain-not-allowed.png',
    ]);
  });
});

describe('the manifest', () => {
  it('is valid JSON with no temporary file left beside it', async () => {
    const { evidence } = await replay(workingSurface());

    const entries = await readdir(evidence.directory);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
    const metadata = JSON.parse(
      await readFile(join(evidence.directory, 'metadata.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(metadata['runId']).toBe(RUN_ID);
    expect(metadata['completedAt']).toBeTypeOf('string');
  });

  it('stays inside the configured evidence directory', async () => {
    const { evidence } = await replay(workingSurface());

    expect(evidence.directory.startsWith(join(evidenceDir, 'runs'))).toBe(true);
  });
});
