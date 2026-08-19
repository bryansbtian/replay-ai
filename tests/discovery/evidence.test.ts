import { describe, expect, it } from 'vitest';

import { DiscoveryEngine, type DiscoveryRequest } from '../../src/discovery/index.js';
import { FakeSurface } from '../replay/support/fakeSurface.js';

import {
  RecordingEvidence,
  ScriptedLlm,
  silentLogger,
  testPolicy,
  TEST_TIMEOUTS,
} from './support/fakes.js';

/**
 * What a discovery run writes down, and what it refuses to.
 *
 * Evidence is the part of this system that outlives the run, so these are the tests that
 * matter most for the safety claims: a reader has to be able to follow what happened, and
 * a value somebody typed, a reasoning trace, and a raw provider body have to be absent
 * whether or not anybody remembered to leave them out.
 */

const ENTRY = 'https://demo.replay-ai.test/members';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

/** A value the run types in, chosen so a leak into the record is unambiguous. */
const MEMBER_REFERENCE = 'MEMBER-REFERENCE-9182736455';

/** What a reasoning model would emit beside its answer, if anything read it. */
const CHAIN_OF_THOUGHT =
  'Let me think step by step about whether the operator is watching this run.';

const REQUEST: DiscoveryRequest = {
  goal: 'Look Up A Demo Member And Read Their Savings Balance',
  target: { name: 'Demo Member Lookup', entryPoint: ENTRY },
};

const MEMBER_ID_FIELD = {
  description: 'Member ID Field',
  strategies: [{ kind: 'label', text: 'Member ID' }],
};

const SEARCH_BUTTON = {
  description: 'Search Button',
  strategies: [{ kind: 'role', role: 'button', name: 'Search' }],
};

async function runOne(): Promise<{ evidence: RecordingEvidence }> {
  const llm = new ScriptedLlm([
    JSON.stringify({
      type: 'action',
      action: { type: 'fill', target: MEMBER_ID_FIELD, value: MEMBER_REFERENCE },
      summary: 'Enter the member reference into the lookup field',
    }),
    JSON.stringify({
      type: 'action',
      action: { type: 'click', target: SEARCH_BUTTON },
      summary: 'Submit the member search form',
    }),
    JSON.stringify({
      type: 'complete',
      summary: 'The member summary is visible with the savings balance on it.',
      outputs: { savingsBalance: '5234.17' },
    }),
  ]);

  const screens = ['Demo Member Lookup', 'Demo Member Lookup Searching', 'Member Summary 5234.17'];
  let seen = -1;

  const surface = new FakeSurface({
    url: ENTRY,
    observe: (): { textSummary: string } => {
      seen += 1;
      return { textSummary: screens[Math.min(seen, screens.length - 1)] ?? '' };
    },
  });

  const evidence = new RecordingEvidence();
  const engine = new DiscoveryEngine({
    surface,
    llm,
    policy: testPolicy(),
    evidence,
    logger: silentLogger(),
    timeouts: TEST_TIMEOUTS,
    runId: RUN_ID,
  });

  const result = await engine.discover(REQUEST);
  expect(result.status).toBe('success');
  return { evidence };
}

describe('the record a discovery run leaves', () => {
  it('tells the story of the run from the goal to the completion', async () => {
    const { evidence } = await runOne();

    expect(evidence.names()).toEqual([
      'policy_evaluated',
      'action_started',
      'action_completed',
      'observation_captured',
      'model_request',
      'model_decision',
      'policy_evaluated',
      'action_started',
      'action_completed',
      'observation_captured',
      'model_request',
      'model_decision',
      'policy_evaluated',
      'action_started',
      'action_completed',
      'observation_captured',
      'model_request',
      'model_decision',
      'goal_completed',
    ]);
  });

  it('records what the model decided as a type, an action, and its own one-line summary', async () => {
    const { evidence } = await runOne();
    const decisions = evidence.named('model_decision');

    expect(decisions[0]?.fields).toMatchObject({
      step: 1,
      decisionType: 'action',
      actionType: 'fill',
      action: 'fill "Member ID Field"',
      summary: 'Enter the member reference into the lookup field',
    });
    expect(decisions[2]?.fields).toMatchObject({
      decisionType: 'complete',
      outputNames: ['savingsBalance'],
    });
  });

  it('records every policy question and its answer, not only the refusals', async () => {
    const { evidence } = await runOne();
    const evaluated = evidence.named('policy_evaluated');

    // The opening navigation and both proposed actions.
    expect(evaluated).toHaveLength(3);
    for (const entry of evaluated) {
      expect(entry.fields['outcome']).toBe('allow');
    }
  });

  it('records the observation as a shape and a fingerprint rather than its content', async () => {
    const { evidence } = await runOne();
    const observed = evidence.named('observation_captured');

    expect(Object.keys(observed[0]?.fields ?? {}).sort()).toEqual([
      'controlCount',
      'state',
      'step',
      'textLength',
      'title',
      'url',
    ]);
    // The page text is a length and a digest. A balance on screen is not copied into a
    // file that outlives the run.
    expect(evidence.serialized()).not.toContain('Member Summary 5234.17');
  });
});

describe('what the record refuses to carry', () => {
  it('never writes down a value the run typed into the application', async () => {
    const { evidence } = await runOne();

    expect(evidence.serialized()).not.toContain(MEMBER_REFERENCE);
  });

  it('never writes down the values the run read out, only their names', async () => {
    const { evidence } = await runOne();

    expect(evidence.serialized()).toContain('savingsBalance');
    expect(evidence.serialized()).not.toContain('5234.17');
  });

  it('stores only the defined decision fields, never a provider response body', async () => {
    // The model answers with a reasoning preamble around the decision, the way a model
    // that was asked to think out loud would. The decision is used; the rest is not
    // stored, because the journal has no field able to hold it.
    const llm = new ScriptedLlm([
      `${CHAIN_OF_THOUGHT}\n{"type":"action","action":{"type":"click","target":${JSON.stringify(SEARCH_BUTTON)}},"summary":"Submit the search"}`,
      '{"type":"complete","summary":"The results are on screen.","outputs":{}}',
    ]);

    let screen = 0;
    const surface = new FakeSurface({
      url: ENTRY,
      observe: (): { textSummary: string } => {
        screen += 1;
        return { textSummary: `Screen ${screen}` };
      },
    });
    const evidence = new RecordingEvidence();

    await new DiscoveryEngine({
      surface,
      llm,
      policy: testPolicy(),
      evidence,
      logger: silentLogger(),
      timeouts: TEST_TIMEOUTS,
      runId: RUN_ID,
    }).discover(REQUEST);

    expect(evidence.serialized()).not.toContain('think step by step');
    expect(evidence.serialized()).not.toContain('operator is watching');

    // Every model_decision event carries exactly the fields the journal defines, so a
    // future call site cannot widen the record by passing something else through.
    for (const entry of evidence.named('model_decision')) {
      for (const key of Object.keys(entry.fields)) {
        expect([
          'step',
          'decisionType',
          'actionType',
          'action',
          'summary',
          'outputNames',
          'reason',
          'model',
          'inputSize',
          'outputSize',
          'modelDurationMs',
        ]).toContain(key);
      }
    }
  });

  it('records that a model request happened and what it cost, never what was in it', async () => {
    const { evidence } = await runOne();
    const requests = evidence.named('model_request');

    for (const entry of requests) {
      expect(Object.keys(entry.fields).sort()).toEqual(['attempt', 'budgetMs', 'step']);
    }
    // The prompt carries the goal and the current screen, and is never written down.
    expect(evidence.serialized()).not.toContain('Respond with one JSON decision');
  });

  it('records a rejected answer as what was wrong with it, not as the text', async () => {
    const llm = new ScriptedLlm(['I think I should click Search.', 'Still not a decision.']);
    const evidence = new RecordingEvidence();

    await new DiscoveryEngine({
      surface: new FakeSurface({ url: ENTRY }),
      llm,
      policy: testPolicy(),
      evidence,
      logger: silentLogger(),
      timeouts: TEST_TIMEOUTS,
      runId: RUN_ID,
    }).discover(REQUEST);

    const rejected = evidence.named('model_response_invalid');
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.fields['issue']).toBe('the response contained no JSON object');
    expect(evidence.serialized()).not.toContain('I think I should click Search');
  });
});

describe('a run that was stopped', () => {
  it('says why, in the result vocabulary, as the last thing it writes', async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({
        type: 'action',
        action: { type: 'navigate', url: 'https://elsewhere.example.com/transfer' },
        summary: 'Move the money',
      }),
    ]);
    const evidence = new RecordingEvidence();

    await new DiscoveryEngine({
      surface: new FakeSurface({ url: ENTRY }),
      llm,
      policy: testPolicy(),
      evidence,
      logger: silentLogger(),
      timeouts: TEST_TIMEOUTS,
      runId: RUN_ID,
    }).discover(REQUEST);

    expect(evidence.named('policy_blocked')[0]?.fields).toMatchObject({
      code: 'POLICY_DOMAIN_NOT_ALLOWED',
    });
    const last = evidence.events.at(-1);
    expect(last?.event).toBe('discovery_stopped');
    expect(last?.fields).toMatchObject({ code: 'DISCOVERY_POLICY_BLOCKED', kind: 'policy' });
  });
});
