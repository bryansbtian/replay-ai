import { mkdtemp, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EvidenceWriteError,
  FileEvidenceRecorder,
  InvalidRunIdError,
  NO_EVIDENCE,
} from '../../src/evidence/index.js';
import { DEFAULT_POLICY, summarizePolicy } from '../../src/policy/index.js';

/**
 * The durable record of a run.
 *
 * Every case writes into a temporary directory that is removed afterwards, so the suite
 * never touches the repository's own `evidence/` directory, which holds committed
 * examples.
 */

const RUN_ID = '11111111-2222-4333-8444-555555555555';

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'replay-ai-evidence-'));
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

function recorder(runId = RUN_ID): FileEvidenceRecorder {
  return new FileEvidenceRecorder({
    evidenceDir,
    runId,
    now: () => new Date('2026-08-19T12:00:00.000Z'),
  });
}

const START = {
  runId: RUN_ID,
  capabilityId: 'lookup-demo-member',
  capabilityVersion: 2,
  capabilityName: 'Lookup Demo Member',
  inputNames: ['memberId'],
  policy: summarizePolicy(DEFAULT_POLICY),
};

async function metadataOf(subject: FileEvidenceRecorder): Promise<Record<string, unknown>> {
  const text = await readFile(join(subject.directory, 'metadata.json'), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

async function eventsOf(subject: FileEvidenceRecorder): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(subject.directory, 'events.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('starting a run', () => {
  it('creates the run directory under the configured evidence directory', async () => {
    const subject = recorder();

    await subject.start(START);

    expect(subject.directory).toBe(join(evidenceDir, 'runs', RUN_ID));
    expect(await readdir(subject.directory)).toEqual(
      expect.arrayContaining(['metadata.json', 'events.jsonl', 'screenshots']),
    );
  });

  it('writes a manifest before the run has finished, so a killed run still says what ran', async () => {
    const subject = recorder();

    await subject.start(START);

    const metadata = await metadataOf(subject);
    expect(metadata['status']).toBe('running');
    expect(metadata['capabilityId']).toBe('lookup-demo-member');
    expect(metadata['completedAt']).toBeUndefined();
  });

  it('records the policy that was in force', async () => {
    const subject = recorder();

    await subject.start(START);

    expect(await metadataOf(subject)).toMatchObject({
      policy: { allowedHosts: [], riskPolicy: { irreversible: 'block' } },
    });
  });

  it('records input names and never a value', async () => {
    const subject = recorder();

    await subject.start(START);

    const metadata = await metadataOf(subject);
    expect(metadata['inputNames']).toEqual(['memberId']);
    expect(JSON.stringify(metadata)).not.toContain('12345');
  });
});

describe('events', () => {
  it('writes one JSON document per line', async () => {
    const subject = recorder();
    await subject.start(START);

    await subject.recordEvent({ event: 'step_started', fields: { stepId: 'open-lookup' } });
    await subject.recordEvent({ event: 'step_completed', fields: { stepId: 'open-lookup' } });

    const events = await eventsOf(subject);
    expect(events.map((event) => event['event'])).toEqual([
      'run_started',
      'step_started',
      'step_completed',
    ]);
    expect(events[1]).toMatchObject({ runId: RUN_ID, stepId: 'open-lookup' });
    expect(events[1]?.['timestamp']).toBe('2026-08-19T12:00:00.000Z');
  });

  it('redacts a field that should never be persisted', async () => {
    const subject = recorder();
    await subject.start(START);

    await subject.recordEvent({ event: 'step_started', fields: { sessionToken: 'real-token' } });

    expect(JSON.stringify(await eventsOf(subject))).not.toContain('real-token');
  });

  it('never throws, because losing a line must not change what an automation did', async () => {
    const subject = recorder();
    await subject.start(START);
    await rm(subject.directory, { recursive: true, force: true });

    await expect(subject.recordEvent({ event: 'step_started' })).resolves.toBeUndefined();
    expect(subject.warnings).toHaveLength(1);
    expect(subject.warnings[0]).toContain('step_started');
  });
});

describe('screenshots', () => {
  const image = new Uint8Array([137, 80, 78, 71]);

  it('stores a capture under a deterministic, ordered name', async () => {
    const subject = recorder();
    await subject.start(START);

    const first = await subject.saveScreenshot('REPLAY_WAIT_TIMEOUT', image);
    const second = await subject.saveScreenshot('POLICY_DOMAIN_NOT_ALLOWED', image);

    expect(first).toBe('001-replay-wait-timeout.png');
    expect(second).toBe('002-policy-domain-not-allowed.png');
    expect(await readdir(join(subject.directory, 'screenshots'))).toEqual([first, second]);
  });

  it('records the capture as an event', async () => {
    const subject = recorder();
    await subject.start(START);

    await subject.saveScreenshot('REPLAY_WAIT_TIMEOUT', image);

    const events = await eventsOf(subject);
    expect(events.at(-1)).toMatchObject({
      event: 'screenshot_captured',
      file: '001-replay-wait-timeout.png',
    });
  });

  it('cannot be made to write outside its own directory', async () => {
    const subject = recorder();
    await subject.start(START);

    const name = await subject.saveScreenshot('../../escaped', image);

    expect(name).toBe('001-escaped.png');
    expect(await readdir(join(subject.directory, 'screenshots'))).toEqual([name]);
  });

  it('warns and carries on when a capture cannot be stored', async () => {
    const subject = recorder();
    await subject.start(START);
    await rm(join(subject.directory, 'screenshots'), { recursive: true, force: true });

    const name = await subject.saveScreenshot('REPLAY_WAIT_TIMEOUT', image);

    expect(name).toBeUndefined();
    expect(subject.warnings[0]).toContain('screenshot');
  });
});

describe('completing a run', () => {
  it('finalizes a success', async () => {
    const subject = recorder();
    await subject.start(START);

    await subject.complete({
      status: 'success',
      durationMs: 512,
      completedSteps: 7,
      recoveries: 0,
      outputNames: ['memberName', 'savingsBalance'],
    });

    expect(await metadataOf(subject)).toMatchObject({
      status: 'success',
      durationMs: 512,
      completedSteps: 7,
      completedAt: '2026-08-19T12:00:00.000Z',
      outputNames: ['memberName', 'savingsBalance'],
    });
  });

  it('finalizes a business outcome', async () => {
    const subject = recorder();
    await subject.start(START);

    await subject.complete({
      status: 'businessOutcome',
      code: 'MEMBER_NOT_FOUND',
      durationMs: 300,
      completedSteps: 4,
      recoveries: 0,
    });

    expect(await metadataOf(subject)).toMatchObject({
      status: 'businessOutcome',
      code: 'MEMBER_NOT_FOUND',
    });
  });

  it('finalizes a policy block', async () => {
    const subject = recorder();
    await subject.start(START);

    await subject.complete({
      status: 'failure',
      code: 'POLICY_DOMAIN_NOT_ALLOWED',
      kind: 'policy',
      stepId: 'open-lookup',
      durationMs: 20,
      completedSteps: 0,
      recoveries: 0,
    });

    expect(await metadataOf(subject)).toMatchObject({
      status: 'failure',
      code: 'POLICY_DOMAIN_NOT_ALLOWED',
      kind: 'policy',
    });
  });

  it('carries any warnings it collected into the manifest', async () => {
    const subject = recorder();
    await subject.start(START);
    await subject.saveScreenshot('x', new Uint8Array());
    await rm(join(subject.directory, 'screenshots'), { recursive: true, force: true });
    await subject.saveScreenshot('y', new Uint8Array());

    await subject.complete({ status: 'success', durationMs: 1, completedSteps: 1, recoveries: 0 });

    const metadata = await metadataOf(subject);
    expect(metadata['warnings']).toHaveLength(1);
  });

  it('surfaces a manifest failure rather than producing a run directory that says nothing', async () => {
    const subject = recorder();
    await subject.start(START);
    await chmod(subject.directory, 0o500);

    await expect(
      subject.complete({ status: 'success', durationMs: 1, completedSteps: 1, recoveries: 0 }),
    ).rejects.toBeInstanceOf(EvidenceWriteError);

    await chmod(subject.directory, 0o700);
  });

  it('leaves no half-written manifest behind', async () => {
    const subject = recorder();
    await subject.start(START);
    await subject.complete({ status: 'success', durationMs: 1, completedSteps: 1, recoveries: 0 });

    const entries = await readdir(subject.directory);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
    await expect(metadataOf(subject)).resolves.toBeTypeOf('object');
  });
});

describe('run identifiers', () => {
  it.each([
    '../../../etc',
    'run/../..',
    '',
    'not-a-uuid',
    '11111111-2222-4333-8444-555555555555/../evil',
  ])('refuses %s, which could name a directory somewhere else', (runId) => {
    expect(() => recorder(runId)).toThrow(InvalidRunIdError);
  });

  it('keeps a valid run inside the configured directory', () => {
    expect(recorder().directory.startsWith(join(evidenceDir, 'runs'))).toBe(true);
  });
});

describe('recording nothing', () => {
  it('is a working recorder that writes no files and asks for no screenshots', async () => {
    await expect(NO_EVIDENCE.start(START)).resolves.toBeUndefined();
    await expect(NO_EVIDENCE.recordEvent({ event: 'run_started' })).resolves.toBeUndefined();
    await expect(
      NO_EVIDENCE.complete({ status: 'success', durationMs: 1, completedSteps: 0, recoveries: 0 }),
    ).resolves.toBeUndefined();
    expect(NO_EVIDENCE.capturesScreenshots).toBe(false);
    expect(await readdir(evidenceDir)).toEqual([]);
  });
});
