import { expect, test } from '@playwright/test';

import {
  createWorkspace,
  EXIT_BUSINESS_OUTCOME,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_POLICY_BLOCKED,
  installArtifact,
  readEvidence,
  resultOf,
  runCliProcess,
  type Workspace,
} from './support/cli.js';

/**
 * Deterministic replay, through the published command.
 *
 * The fixture is the controlled demo console, served over HTTP by the Playwright
 * `webServer`. Every scenario is reached by the member id it is searched for, so a case
 * reads as "run the real command for this member, get that exit code".
 *
 * These runs are given no model configuration of any kind. That is the point: replay is
 * supposed to work with no provider reachable, and a run that quietly fell back to one
 * would fail here rather than pass.
 */

const FIXTURE_URL = 'http://127.0.0.1:3100/member-lookup.html';

const EXAMPLE = 'tests/fixtures/capabilities/lookup-demo-member.json';

/** The demo console's origin, and http, which a production deployment would not enable. */
const FIXTURE_POLICY = {
  POLICY_ALLOWED_HOSTS: '127.0.0.1:3100',
  POLICY_ALLOWED_SCHEMES: 'http',
};

let workspace: Workspace;
let artifactPath: string;

test.beforeAll(async () => {
  workspace = await createWorkspace();
  artifactPath = await installArtifact(workspace, EXAMPLE, FIXTURE_URL);
});

async function replay(
  memberId: string,
  overrides: Readonly<Record<string, string>> = {},
): Promise<Awaited<ReturnType<typeof runCliProcess>>> {
  return await runCliProcess(
    ['replay', '--artifact', artifactPath, '--input', `memberId=${memberId}`],
    { env: { ...workspace.env(), ...FIXTURE_POLICY, ...overrides } },
  );
}

test('replays a saved capability and returns the declared outputs', async () => {
  const run = await replay('12345');

  expect(run.code).toBe(EXIT_OK);
  const result = resultOf(run);
  expect(result['status']).toBe('success');
  // savingsBalance is declared as a number, so replay returns it as one rather than
  // handing back whatever the page happened to render.
  expect(result['outputs']).toEqual({ memberName: 'Ada Lovelace', savingsBalance: 5234.17 });
  expect(run.stderr).toContain('Replay Completed');
});

test('reads a different member when the invocation input changes', async () => {
  const run = await replay('67890');

  expect(run.code).toBe(EXIT_OK);
  const result = resultOf(run);
  expect(result['status']).toBe('success');
  // The capability was compiled from a run that searched for a different member. Nothing
  // about this member is in the artifact, which is what makes it a parameter.
  expect(result['outputs']).toEqual({ memberName: 'Grace Hopper', savingsBalance: 118.05 });
});

test('makes no model call, and needs no provider to be reachable', async () => {
  const run = await replay('12345', {
    // Pointed at a port nothing listens on. A replay that consulted a model would fail;
    // this one does not notice.
    LLM_PROVIDER: 'ollama',
    OLLAMA_BASE_URL: 'http://127.0.0.1:9',
  });

  expect(run.code).toBe(EXIT_OK);
  expect(resultOf(run)['status']).toBe('success');

  const runId = resultOf(run)['replayId'] as string;
  const evidence = await readEvidence(workspace, runId);
  const names = evidence.events.map((event) => event['event']);
  // The vocabulary a model run would write into, absent because no model ran.
  for (const modelEvent of ['model_request', 'model_decision', 'observation_captured']) {
    expect(names).not.toContain(modelEvent);
  }
});

test('reports a declared business outcome as an answer, not a failure', async () => {
  const run = await replay('00000');

  expect(run.code).toBe(EXIT_BUSINESS_OUTCOME);
  const result = resultOf(run);
  expect(result['status']).toBe('businessOutcome');
  expect(result['code']).toBe('MEMBER_NOT_FOUND');
});

test('recovers from a condition the capability declares, and says that it did', async () => {
  const run = await replay('77777');

  expect(run.code).toBe(EXIT_OK);
  const result = resultOf(run);
  expect(result['status']).toBe('success');
  expect(result['recoveries']).not.toEqual([]);
});

test('fails with a structured diagnosis when a state nothing declares stops the run', async () => {
  const run = await replay('66666');

  expect(run.code).toBe(EXIT_ERROR);
  const result = resultOf(run);
  expect(result['status']).toBe('failure');
  expect(result['stepId']).toBeDefined();
  // A code and a step, not a stack trace.
  expect(run.stderr).not.toContain('at Object.');
});

test('refuses a value the declared output type cannot hold', async () => {
  const run = await replay('24680');

  expect(run.code).toBe(EXIT_ERROR);
  expect(resultOf(run)['status']).toBe('failure');
});

test('is blocked by policy before the browser reaches a host the deployment forbids', async () => {
  const run = await replay('12345', { POLICY_ALLOWED_HOSTS: 'example.test' });

  expect(run.code).toBe(EXIT_POLICY_BLOCKED);
  const result = resultOf(run);
  expect(result['status']).toBe('failure');
  expect(result['kind']).toBe('policy');
});

test('is blocked by policy when the deployment is configured read-only', async () => {
  const run = await replay('12345', {
    POLICY_ALLOWED_ACTIONS: 'navigate,extract,wait,checkpoint',
  });

  expect(run.code).toBe(EXIT_POLICY_BLOCKED);
  expect(resultOf(run)['kind']).toBe('policy');
});

test('writes an evidence directory for every run, whatever the outcome', async () => {
  const success = await replay('12345');
  const failure = await replay('66666');

  for (const run of [success, failure]) {
    const runId = resultOf(run)['replayId'] as string;
    const evidence = await readEvidence(workspace, runId);
    expect(evidence.metadata['runId']).toBe(runId);
    expect(evidence.metadata['capabilityId']).toBe('lookup-demo-member');
    expect(evidence.events.length).toBeGreaterThan(0);
    // The invocation value is never written down.
    expect(JSON.stringify(evidence)).not.toContain('Ada Lovelace');
  }
});
