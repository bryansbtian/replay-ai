import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseCapabilityArtifact, type CapabilityArtifact } from '../../src/artifacts/index.js';
import { FileEvidenceRecorder } from '../../src/evidence/index.js';
import { AutomationSession, HandoffCoordinator } from '../../src/handoff/index.js';
import { DEFAULT_POLICY, summarizePolicy } from '../../src/policy/index.js';
import { ReplayEngine } from '../../src/replay/index.js';
import {
  launchPlaywrightSession,
  PlaywrightSurface,
  type PlaywrightSession,
} from '../../src/surfaces/playwright/index.js';
import { silentLogger } from '../discovery/support/fakes.js';
import { permissivePolicy } from '../replay/support/policy.js';
import { TEST_TIMEOUTS } from '../surfaces/support/fixture.js';

/**
 * The Phase 9 proof, and the one thing about a handoff that cannot be faked.
 *
 * ```text
 * replay -> unexpected state -> intervention -> pause -> a person acts in the same page
 *   -> resume -> replay checks the state -> replay continues -> success
 * ```
 *
 * The person is played by Playwright acting on the very page the surface is driving, which
 * is exactly what a human operating the visible window would do. The session identity is
 * stamped into the page before the run starts and read back afterwards, so the claim that
 * the same browser context survived the handoff is checked rather than asserted: a fresh
 * page would have lost it.
 */

const FIXTURE_URL = pathToFileURL(resolve('tests/fixtures/member-lookup.html')).href;

/** The member whose search puts up a dialog the capability knows nothing about. */
const NEEDS_A_PERSON = '33333';

const ARTIFACT: CapabilityArtifact = parseCapabilityArtifact({
  schemaVersion: '1',
  id: 'lookup-member-balance',
  name: 'Lookup Member Balance',
  description: 'Looks up a demo member by reference and reads their savings balance.',
  version: 1,
  application: { name: 'Demo Member Lookup', entryPoint: FIXTURE_URL },
  inputs: [
    {
      name: 'memberId',
      type: 'string',
      required: true,
      description: 'Member reference.',
      sensitive: false,
    },
  ],
  outputs: [
    { name: 'savingsBalance', type: 'string', description: 'Savings balance on the summary.' },
  ],
  steps: [
    { id: 'open-lookup', type: 'navigate', url: FIXTURE_URL, risk: 'safe' },
    {
      id: 'enter-member-id',
      type: 'fill',
      target: {
        description: 'Member ID Field',
        strategies: [{ kind: 'label', text: 'Member ID' }],
      },
      value: { source: 'input', name: 'memberId' },
      risk: 'safe',
    },
    {
      id: 'click-search',
      type: 'click',
      target: {
        description: 'Search Button',
        strategies: [{ kind: 'role', role: 'button', name: 'Search' }],
      },
      risk: 'safe',
    },
    {
      id: 'await-member-summary',
      type: 'wait',
      condition: { type: 'textVisible', text: 'Member Summary' },
      execution: { timeoutMs: 2_000 },
    },
    {
      id: 'read-savings-balance',
      type: 'extract',
      target: {
        description: 'Savings Balance',
        strategies: [{ kind: 'attribute', attribute: 'data-field', value: 'savings-balance' }],
      },
      output: 'savingsBalance',
    },
  ],
  successCondition: { type: 'textVisible', text: 'Member Summary' },
  metadata: { createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z' },
});

const RUN_ID = '77777777-7777-4777-8777-777777777777';

let session: PlaywrightSession;
let evidenceDir: string;

beforeAll(async () => {
  session = await launchPlaywrightSession({ headless: true });
}, 60_000);

afterAll(async () => {
  await session.close();
});

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), 'replay-ai-handoff-'));
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

async function events(runId: string): Promise<{ event: string }[]> {
  const text = await readFile(join(evidenceDir, 'runs', runId, 'events.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { event: string });
}

describe('a run that needs a person, end to end', () => {
  it('pauses, hands over the same page, resumes, and completes', async () => {
    const surface = new PlaywrightSurface({
      page: session.page,
      logger: silentLogger(),
      timeouts: TEST_TIMEOUTS,
    });
    const evidence = new FileEvidenceRecorder({ evidenceDir, runId: RUN_ID });
    await evidence.start({
      runId: RUN_ID,
      capabilityId: ARTIFACT.id,
      capabilityVersion: ARTIFACT.version,
      capabilityName: ARTIFACT.name,
      inputNames: ['memberId'],
      policy: summarizePolicy(DEFAULT_POLICY),
    });

    const automation = new AutomationSession({
      id: 'session-1',
      runId: RUN_ID,
      automation: 'replay',
      subject: ARTIFACT.name,
    });
    const coordinator = new HandoffCoordinator({
      session: automation,
      surface,
      evidence,
      logger: silentLogger(),
    });

    // Stamped into the browser context before anything runs. A handoff that opened a new
    // browser would lose it, so reading it back at the end is the same-session proof.
    await session.page.goto(FIXTURE_URL);
    await session.page.evaluate(
      `sessionStorage.setItem('replay-ai-session-proof', 'the-original-context')`,
    );

    const engine = new ReplayEngine({
      surface,
      logger: silentLogger(),
      policy: permissivePolicy(),
      evidence,
      timeouts: TEST_TIMEOUTS,
      replayId: RUN_ID,
      intervention: coordinator,
    });

    // The person: waits for the run to pause, takes control, clears the dialog in the page
    // the automation is sitting in, and hands it back.
    const operator = (async (): Promise<void> => {
      await waitFor(() => automation.state === 'waitingForHuman');

      expect(automation.controlOwner).toBe('none');
      await coordinator.takeControl();
      expect(automation.controlOwner).toBe('human');

      await session.page.getByRole('button', { name: 'Continue' }).click();
      await session.page.getByText('Member Summary').waitFor({ timeout: 5_000 });

      await coordinator.resume();
    })();

    const [result] = await Promise.all([
      engine.run(ARTIFACT, { memberId: NEEDS_A_PERSON }),
      operator,
    ]);

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      return;
    }

    // The workflow finished, having read the value out of the application after a person
    // got it there. 12345's balance, because that is what the fixture reveals.
    expect(result.outputs).toEqual({ savingsBalance: '5234.17' });

    // The wait that failed is carried out by the engine once the person cleared the dialog,
    // so it took two attempts and the second one is what proves the state arrived.
    const waited = result.completedSteps.find((step) => step.stepId === 'await-member-summary');
    expect(waited).toMatchObject({ stepId: 'await-member-summary', attempts: 2 });

    // The same browser context throughout: the value written before the run is still there.
    const proof = await session.page.evaluate<string | null>(
      `sessionStorage.getItem('replay-ai-session-proof')`,
    );
    expect(proof).toBe('the-original-context');

    // Control ended up back with the automation.
    expect(automation.state).toBe('running');
    expect(automation.controlOwner).toBe('replay');

    // What the person did is on the record, and so is the shape of the handoff.
    expect(automation.humanActions.some((action) => action.actionType === 'click')).toBe(true);

    await evidence.complete({
      status: result.status,
      durationMs: result.durationMs,
      completedSteps: result.completedSteps.length,
      recoveries: 0,
    });

    // One coherent timeline for one run, rather than a separate record for the handoff.
    const timeline = (await events(RUN_ID)).map((entry) => entry.event);
    expect(timeline).toContain('intervention_requested');
    expect(timeline).toContain('automation_paused');
    expect(timeline).toContain('human_control_started');
    expect(timeline).toContain('human_action');
    expect(timeline).toContain('human_control_ended');
    expect(timeline).toContain('automation_resumed');
    expect(timeline).toContain('run_completed');

    // In order: the run stopped, a person arrived, then it carried on.
    expect(timeline.indexOf('intervention_requested')).toBeLessThan(
      timeline.indexOf('human_control_started'),
    );
    expect(timeline.indexOf('human_control_ended')).toBeLessThan(
      timeline.indexOf('automation_resumed'),
    );
  }, 60_000);
});

/** Waits for a condition the paused run will bring about, without a fixed sleep. */
async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('The run never reached the expected state.');
    }
    await new Promise((settle) => setTimeout(settle, 25));
  }
}
