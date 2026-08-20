import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  createWorkspace,
  EXIT_OK,
  readEvidence,
  resultOf,
  runCliProcess,
  type Workspace,
} from './support/cli.js';
import { startStubModel, type StubModel } from './support/stubModel.js';

/**
 * The whole lifecycle, through the published commands.
 *
 * ```text
 * goal -> discovery -> trace -> compilation -> validation -> verification replay -> artifact
 *                                                                                      |
 *                                                                     replay, with no model
 * ```
 *
 * Everything here is real except which decision the model returns next. The run drives a
 * real browser against the served demo console, policy evaluates every action, the
 * compiler parameterizes the value that was typed, the artifact is validated and replayed
 * before it is allowed to exist, and the file it writes is then replayed again by a
 * separate process that has no model configured at all.
 */

const FIXTURE_URL = 'http://127.0.0.1:3100/member-lookup.html';

const MEMBER_ID_FIELD = {
  description: 'Member ID Field',
  strategies: [
    { kind: 'label', text: 'Member ID' },
    { kind: 'attribute', attribute: 'data-testid', value: 'member-id' },
  ],
};

const SEARCH_BUTTON = {
  description: 'Search Button',
  strategies: [{ kind: 'role', role: 'button', name: 'Search' }],
};

const MEMBER_SUMMARY = {
  description: 'Member Summary',
  strategies: [{ kind: 'role', role: 'region', name: 'Member Summary' }],
};

const SAVINGS_BALANCE = {
  description: 'Savings Balance',
  strategies: [{ kind: 'attribute', attribute: 'data-field', value: 'savings-balance' }],
};

/** The workflow, as the decisions a model would have to make to perform it. */
const SCRIPT = [
  {
    type: 'action',
    summary: 'Enter the member reference in the lookup field.',
    action: { type: 'fill', target: MEMBER_ID_FIELD, value: '12345' },
  },
  {
    type: 'action',
    summary: 'Submit the lookup.',
    action: { type: 'click', target: SEARCH_BUTTON },
  },
  {
    type: 'action',
    summary: 'Wait for the member summary to appear.',
    action: { type: 'wait', condition: { type: 'targetVisible', target: MEMBER_SUMMARY } },
  },
  {
    type: 'action',
    summary: 'Read the savings balance from the summary.',
    action: { type: 'extract', target: SAVINGS_BALANCE, name: 'savingsBalance' },
  },
  {
    type: 'complete',
    summary: 'The member summary is on screen and the savings balance has been read.',
    outputs: { savingsBalance: '5234.17' },
  },
];

const FIXTURE_POLICY = {
  POLICY_ALLOWED_HOSTS: '127.0.0.1:3100',
  POLICY_ALLOWED_SCHEMES: 'http',
};

let workspace: Workspace;
let model: StubModel;

test.beforeAll(async () => {
  workspace = await createWorkspace();
  model = await startStubModel(SCRIPT);
});

test.afterAll(async () => {
  await model.close();
});

// A browser start, a discovery loop, a compilation, and a verification replay in one
// process. The default per-test budget is for a page interaction, not for this.
test.describe.configure({ timeout: 180_000 });

test('discovers a workflow, compiles it, verifies it, and saves a replayable capability', async () => {
  const discovery = await runCliProcess(
    [
      'discover',
      '--goal',
      'Look Up Demo Member 12345 And Read Their Savings Balance',
      '--target',
      FIXTURE_URL,
      '--name',
      'Demo Member Lookup',
      '--input',
      'memberId=12345',
      '--capability-name',
      'Lookup Member Balance',
      '--capability-description',
      'Looks up a demo member by reference and reads their savings balance.',
    ],
    {
      env: {
        ...workspace.env(),
        ...FIXTURE_POLICY,
        LLM_PROVIDER: 'ollama',
        OLLAMA_BASE_URL: model.baseUrl,
        OLLAMA_MODEL: 'stub-model',
      },
    },
  );

  expect(discovery.code).toBe(EXIT_OK);
  const result = resultOf(discovery);
  expect(result['status']).toBe('success');

  const compilation = result['compilation'] as Record<string, unknown>;
  expect(compilation['status']).toBe('compiled');
  expect(compilation['capabilityId']).toBe('lookup-member-balance');
  // The value that was typed became a parameter, not a constant in the steps.
  expect(compilation['inputs']).toEqual(['memberId']);
  expect(compilation['outputs']).toEqual(['savingsBalance']);

  // Three runs, one chain: the discovery run, the verification replay that let the
  // capability be saved, and the ordinary replay below.
  const discoveryRunId = result['runId'] as string;
  const verificationRunId = compilation['verificationReplayRunId'] as string;
  expect(compilation['sourceDiscoveryRunId']).toBe(discoveryRunId);
  expect(verificationRunId).not.toBe(discoveryRunId);

  const artifactPath = compilation['artifactPath'] as string;
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as Record<string, unknown>;

  // What the artifact may not carry: the discovered value baked in as a step literal, or
  // anything the model said.
  const fill = (artifact['steps'] as Record<string, unknown>[]).find(
    (step) => step['type'] === 'fill',
  );
  expect(fill?.['value']).toEqual({ source: 'input', name: 'memberId' });
  expect(JSON.stringify(artifact)).not.toContain('12345');
  const serialized = JSON.stringify(artifact);
  // Nothing the model produced survives into the artifact: not the rationale it gave for
  // each decision, not the model identifier, and not the outputs it claimed.
  for (const decision of SCRIPT) {
    expect(serialized).not.toContain((decision as { summary: string }).summary);
  }
  expect(serialized).not.toMatch(/stub-model|prompt|reasoning/i);
  expect(artifact['successCondition']).toBeDefined();

  // Discovery evidence records that a model was consulted, without recording what it said
  // beyond the bounded summary the decision schema already accepted.
  const evidence = await readEvidence(workspace, discoveryRunId);
  const names = evidence.events.map((event) => event['event']);
  expect(names).toContain('model_decision');
  expect(names).toContain('policy_evaluated');
  expect(names).toContain('goal_completed');
  expect(evidence.metadata['kind']).toBe('discovery');

  // The saved capability now replays in a process with no model configuration at all.
  const replay = await runCliProcess(
    ['replay', '--artifact', artifactPath, '--input', 'memberId=67890'],
    { env: { ...workspace.env(), ...FIXTURE_POLICY } },
  );

  expect(replay.code).toBe(EXIT_OK);
  const replayed = resultOf(replay);
  expect(replayed['status']).toBe('success');
  // A member the discovery run never saw.
  expect(replayed['outputs']).toEqual({ savingsBalance: '118.05' });

  const replayEvidence = await readEvidence(workspace, replayed['replayId'] as string);
  expect(replayEvidence.events.map((event) => event['event'])).not.toContain('model_decision');
});
