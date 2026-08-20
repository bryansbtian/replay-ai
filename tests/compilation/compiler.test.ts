import { describe, expect, it } from 'vitest';

import { parseCapabilityArtifact, type CapabilityArtifact } from '../../src/artifacts/index.js';
import { compileDraft, CompilationProblem } from '../../src/compilation/index.js';
import type { CompilationRequest } from '../../src/compilation/index.js';

import {
  BALANCE_FIELD,
  entry,
  goesNowhereTrace,
  MEMBER_ID_FIELD,
  memberLookupTrace,
  SEARCH_BUTTON,
  SUMMARY_SCREEN,
} from './support/traces.js';

/**
 * The transformation from a run to a workflow.
 *
 * Every case here is about the difference between the two documents: a trace records what
 * one run typed, and an artifact has to describe what every future run should do. The
 * compiler is pure, so none of this touches a browser, a model, or a disk.
 */

const REQUEST: CompilationRequest = {
  id: 'lookup-member-balance',
  name: 'Lookup Member Balance',
  description: 'Looks up a member by reference and reads their savings balance.',
};

const NOW = (): Date => new Date('2026-08-19T10:00:00.000Z');

/** Compiles and validates, which is the only way an artifact is ever produced. */
function compile(
  trace = memberLookupTrace(),
  request: CompilationRequest = REQUEST,
): CapabilityArtifact {
  const { draft } = compileDraft(trace, request, { now: NOW });
  return parseCapabilityArtifact(draft);
}

describe('normalizing a trace into steps', () => {
  it('opens the application before the first discovered action', () => {
    const artifact = compile();

    // The run navigated before its first decision, so the workflow has to as well. Replay
    // starts wherever the surface happens to be.
    expect(artifact.steps[0]).toMatchObject({
      type: 'navigate',
      url: 'https://demo.replay-ai.test/members',
    });
  });

  it('compiles each supported action into the step that performs it', () => {
    const artifact = compile();

    expect(artifact.steps.map((step) => step.type)).toEqual([
      'navigate',
      'fill',
      'click',
      'wait',
      'extract',
    ]);
  });

  it('does not compile actions that failed during discovery', () => {
    const trace = memberLookupTrace({
      entries: [
        entry(1, { type: 'click', target: BALANCE_FIELD }, { ok: false }),
        entry(2, { type: 'fill', target: MEMBER_ID_FIELD, value: '12345' }),
        entry(3, { type: 'click', target: SEARCH_BUTTON }, { after: SUMMARY_SCREEN }),
      ],
    });

    const { draft, skippedActions } = compileDraft(trace, REQUEST, { now: NOW });
    const artifact = parseCapabilityArtifact(draft);

    // A locator that did not resolve is a mistake the run recovered from, not a step.
    // Reported rather than hidden.
    expect(skippedActions).toBe(1);
    expect(artifact.steps.map((step) => step.type)).toEqual(['navigate', 'fill', 'click']);
  });

  it('refuses a run that carried out nothing', () => {
    const trace = memberLookupTrace({
      entries: [entry(1, { type: 'click', target: SEARCH_BUTTON }, { ok: false })],
      inputs: [],
    });

    expect(() => compileDraft(trace, REQUEST, { now: NOW })).toThrow(CompilationProblem);
  });

  it('names steps after what they do', () => {
    const artifact = compile();

    expect(artifact.steps.map((step) => step.id)).toEqual([
      'open-demo-member-lookup',
      'enter-member-id',
      'click-search',
      'await-member-summary',
      'read-savings-balance',
    ]);
  });

  it('keeps step ids unique when a workflow repeats an action', () => {
    const trace = memberLookupTrace({
      entries: [
        entry(1, { type: 'click', target: SEARCH_BUTTON }),
        entry(2, { type: 'click', target: SEARCH_BUTTON }, { after: SUMMARY_SCREEN }),
      ],
      inputs: [],
      discovered: [],
    });

    const artifact = compile(trace);

    expect(artifact.steps.map((step) => step.id)).toEqual([
      'open-demo-member-lookup',
      'click-search',
      'click-search-2',
    ]);
  });
});

describe('parameterizing the values a run typed', () => {
  it('binds a value that matches a supplied input to that input', () => {
    const artifact = compile();
    const fill = artifact.steps.find((step) => step.type === 'fill');

    expect(fill).toMatchObject({ value: { source: 'input', name: 'memberId' } });
  });

  it('never writes the supplied value into the artifact', () => {
    const artifact = compile();

    // The whole point of parameterizing. A member reference in a committed file is a
    // capability that looks up one person forever, and a value in a repository.
    expect(JSON.stringify(artifact)).not.toContain('12345');
  });

  it('leaves a workflow constant as a literal', () => {
    const trace = memberLookupTrace({
      entries: [
        entry(1, { type: 'fill', target: MEMBER_ID_FIELD, value: '12345' }),
        entry(
          2,
          { type: 'fill', target: BALANCE_FIELD, value: 'Savings' },
          {
            after: SUMMARY_SCREEN,
          },
        ),
      ],
    });

    const artifact = compile(trace);
    const fills = artifact.steps.filter((step) => step.type === 'fill');

    expect(fills[0]).toMatchObject({ value: { source: 'input', name: 'memberId' } });
    // "Savings" was never supplied as an input, so it is part of the workflow.
    expect(fills[1]).toMatchObject({ value: { source: 'literal', value: 'Savings' } });
  });

  it('binds several inputs, each to the step that typed it', () => {
    const trace = memberLookupTrace({
      inputs: [
        { name: 'memberId', value: '12345' },
        { name: 'branchCode', value: 'BR-9' },
      ],
      entries: [
        entry(1, { type: 'fill', target: MEMBER_ID_FIELD, value: '12345' }),
        entry(
          2,
          { type: 'fill', target: BALANCE_FIELD, value: 'BR-9' },
          {
            after: SUMMARY_SCREEN,
          },
        ),
      ],
    });

    const artifact = compile(trace);

    expect(artifact.inputs.map((input) => input.name)).toEqual(['memberId', 'branchCode']);
    expect(artifact.steps.filter((step) => step.type === 'fill')).toMatchObject([
      { value: { source: 'input', name: 'memberId' } },
      { value: { source: 'input', name: 'branchCode' } },
    ]);
  });

  it('reuses one input across every step that typed its value', () => {
    const trace = memberLookupTrace({
      entries: [
        entry(1, { type: 'fill', target: MEMBER_ID_FIELD, value: '12345' }),
        entry(
          2,
          { type: 'fill', target: BALANCE_FIELD, value: '12345' },
          {
            after: SUMMARY_SCREEN,
          },
        ),
      ],
    });

    const artifact = compile(trace);

    expect(artifact.inputs).toHaveLength(1);
    for (const step of artifact.steps.filter((one) => one.type === 'fill')) {
      expect(step).toMatchObject({ value: { source: 'input', name: 'memberId' } });
    }
  });

  it('refuses to guess when two inputs were given the same value', () => {
    const trace = memberLookupTrace({
      inputs: [
        { name: 'memberId', value: '12345' },
        { name: 'accountId', value: '12345' },
      ],
    });

    // There is no correct answer here, so the compiler says so rather than picking one.
    expect(() => compileDraft(trace, REQUEST, { now: NOW })).toThrow(/more than one/);
  });

  it('refuses an input the run never typed', () => {
    const trace = memberLookupTrace({
      inputs: [{ name: 'branchCode', value: 'BR-9' }],
    });

    expect(() => compileDraft(trace, REQUEST, { now: NOW })).toThrow(/never typed/);
  });

  it('marks a sensitive input as sensitive and still keeps its value out', () => {
    const trace = memberLookupTrace({
      inputs: [{ name: 'memberId', value: '12345', sensitive: true }],
    });

    const artifact = compile(trace);

    expect(artifact.inputs[0]).toMatchObject({ name: 'memberId', sensitive: true });
    expect(JSON.stringify(artifact)).not.toContain('12345');
  });
});

describe('targets', () => {
  it('keeps semantic strategies rather than reducing a control to a selector', () => {
    const artifact = compile();
    const fill = artifact.steps.find((step) => step.type === 'fill');

    expect(fill?.target.strategies).toEqual([
      { kind: 'role', role: 'textbox', name: 'Member ID' },
      { kind: 'label', text: 'Member ID' },
    ]);
  });

  it('removes a strategy the model listed twice', () => {
    const trace = memberLookupTrace({
      entries: [
        entry(
          1,
          {
            type: 'click',
            target: {
              description: 'Search Button',
              strategies: [
                { kind: 'role', role: 'button', name: 'Search' },
                { kind: 'role', role: 'button', name: 'Search' },
                { kind: 'text', text: 'Search' },
              ],
            },
          },
          { after: SUMMARY_SCREEN },
        ),
      ],
      inputs: [],
      discovered: [],
    });

    const artifact = compile(trace);
    const click = artifact.steps.find((step) => step.type === 'click');

    expect(click?.target.strategies).toHaveLength(2);
  });

  it('carries nothing from Playwright or a provider into the artifact', () => {
    const serialized = JSON.stringify(compile());

    for (const forbidden of ['locator', 'Locator', 'page', 'anthropic', 'ollama', 'prompt']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('outputs', () => {
  it('declares an output for each extraction and an extract step that produces it', () => {
    const artifact = compile();

    expect(artifact.outputs).toEqual([
      {
        name: 'savingsBalance',
        type: 'string',
        description: 'Value read from the application as savingsBalance.',
      },
    ]);
    expect(artifact.steps.at(-1)).toMatchObject({ type: 'extract', output: 'savingsBalance' });
  });

  it('stores how to read the value, never the value the run read', () => {
    const artifact = compile();

    // The distinction the whole phase turns on. An artifact carrying "5234.17" would
    // return one member's balance to every future caller.
    expect(JSON.stringify(artifact)).not.toContain('5234.17');
  });

  it('stays with string typing rather than claiming a conversion replay cannot do', () => {
    const artifact = compile();

    for (const output of artifact.outputs) {
      expect(output.type).toBe('string');
    }
  });

  it('uses a supplied description when one is given', () => {
    const artifact = compile(memberLookupTrace(), {
      ...REQUEST,
      outputs: [{ name: 'savingsBalance', description: 'Savings balance shown on the summary.' }],
    });

    expect(artifact.outputs[0]?.description).toBe('Savings balance shown on the summary.');
  });
});

describe('the success condition', () => {
  it('is built from the state the workflow arrived at', () => {
    const artifact = compile();

    // Not the last button pressed. The Member Summary region did not exist on the first
    // screen and does on the last, which is the run's own evidence that it got somewhere.
    expect(artifact.successCondition).toMatchObject({
      type: 'targetVisible',
      target: {
        strategies: [{ kind: 'role', role: 'region', name: 'Member Summary' }],
      },
    });
  });

  it('refuses to compile a run that ended where it started', () => {
    expect(() => compileDraft(goesNowhereTrace(), REQUEST, { now: NOW })).toThrow(
      /no observed state/,
    );
  });

  it('uses the last observed screen rather than a loading heading after a click', () => {
    const searching = [
      { role: 'heading', name: 'Searching restaurants…', enabled: true },
      { role: 'textbox', name: 'Member ID', enabled: true },
      { role: 'button', name: 'Search', enabled: true },
    ];
    const results = [
      { role: 'heading', name: '1 result for Japanese', enabled: true },
      { role: 'textbox', name: 'Member ID', enabled: true },
      { role: 'button', name: 'Search', enabled: true },
    ];
    const trace = memberLookupTrace({
      inputs: [{ name: 'cuisine', value: 'Japanese' }],
      entries: [
        entry(1, { type: 'fill', target: MEMBER_ID_FIELD, value: 'Japanese' }),
        entry(2, { type: 'click', target: SEARCH_BUTTON }, { after: searching }),
        entry(
          3,
          { type: 'wait', condition: { type: 'textVisible', text: 'Search Results' } },
          { ok: false, before: searching, after: results },
        ),
      ],
      discovered: [],
      outputs: {},
    });

    const artifact = compile(trace);

    // The failed wait still saw the listing. The click only saw the spinner, and the
    // heading names the cuisine, so the condition has to stay reusable across inputs.
    expect(artifact.successCondition).toEqual({ type: 'textVisible', text: 'result' });
  });
});

describe('declared application states', () => {
  it('carries through a business outcome the caller declared', () => {
    const artifact = compile(memberLookupTrace(), {
      ...REQUEST,
      businessOutcomes: [
        {
          code: 'MEMBER_NOT_FOUND',
          description: 'The console reports that no member matches the supplied reference.',
          condition: { type: 'textVisible', text: 'No Member Matches That Reference' },
          disposition: 'businessOutcome',
        },
      ],
    });

    expect(artifact.businessOutcomes).toHaveLength(1);
    expect(artifact.businessOutcomes[0]?.code).toBe('MEMBER_NOT_FOUND');
  });

  it('invents none of its own', () => {
    expect(compile().businessOutcomes).toEqual([]);
  });
});

describe('the compiled document', () => {
  it('passes the same validation a file read off a disk passes', () => {
    // `compile` already calls the validator, so reaching this line is the assertion. It is
    // stated explicitly because the compiler's output being untrusted is the design.
    expect(() => compile()).not.toThrow();
  });

  it('describes risk without granting anything', () => {
    const artifact = compile();
    const acting = artifact.steps.filter((step) => {
      return step.type === 'navigate' || step.type === 'click' || step.type === 'fill';
    });

    for (const step of acting) {
      expect(step).toMatchObject({ risk: 'safe' });
    }
  });

  it('carries provenance a reviewer can read and nothing a run left behind', () => {
    const artifact = compile();

    expect(artifact).toMatchObject({
      schemaVersion: '1',
      id: 'lookup-member-balance',
      name: 'Lookup Member Balance',
      version: 1,
      application: { name: 'Demo Member Lookup' },
    });
    expect(artifact.metadata.createdAt).toBe('2026-08-19T10:00:00.000Z');
  });

  it('holds no field a model transcript could have arrived in', () => {
    const serialized = JSON.stringify(compile()).toLowerCase();

    // The real protection is the strict schema: there is no field these could live in.
    // This is the regression net under it.
    for (const forbidden of [
      'messages',
      'assistantresponse',
      'chainofthought',
      'reasoning',
      'apikey',
      'transcript',
      'thinking',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('compiles the same trace to the same artifact every time', () => {
    // Determinism is what makes the compiler reviewable rather than merely trusted.
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
  });
});
