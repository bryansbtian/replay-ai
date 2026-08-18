import { describe, expect, it } from 'vitest';

import {
  ArtifactValidationError,
  parseCapabilityArtifact,
  SCHEMA_VERSION,
} from '../../src/artifacts/index.js';

import {
  customerReferenceTarget,
  expectIssue,
  issuesOf,
  minimalArtifact,
  searchButtonTarget,
  successCondition,
  summaryTarget,
  validArtifact,
  type JsonObject,
} from './support/artifacts.js';

/** Parses an artifact whose only difference from the fixture is one replaced step list. */
function parseWithSteps(steps: JsonObject[], overrides: JsonObject = {}): unknown {
  return parseCapabilityArtifact(minimalArtifact({ steps, ...overrides }));
}

describe('parseCapabilityArtifact', () => {
  it('accepts a complete artifact and returns it typed', () => {
    const artifact = parseCapabilityArtifact(validArtifact());

    expect(artifact.id).toBe('lookup-demo-customer');
    expect(artifact.schemaVersion).toBe(SCHEMA_VERSION);
    expect(artifact.version).toBe(1);
    expect(artifact.steps).toHaveLength(4);
    expect(artifact.successCondition.type).toBe('targetVisible');
  });

  it('fills the collections that a minimal artifact leaves out', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({ inputs: undefined, outputs: undefined, businessOutcomes: undefined }),
    );

    expect(artifact.inputs).toEqual([]);
    expect(artifact.outputs).toEqual([]);
    expect(artifact.businessOutcomes).toEqual([]);
    expect(artifact.metadata.tags).toEqual([]);
  });

  it('rejects data that is not an object at all', () => {
    const issues = issuesOf(() => parseCapabilityArtifact('lookup-demo-customer'));

    expectIssue(issues, '', /must be a JSON object/);
  });

  it('names the file path it was given when validation fails', () => {
    const failure = (): unknown => {
      return parseCapabilityArtifact({}, { source: 'capabilities/broken.json' });
    };

    expect(failure).toThrow(ArtifactValidationError);
    expect(failure).toThrow(/capabilities\/broken\.json/);
  });
});

describe('schema version', () => {
  it('accepts the supported version', () => {
    expect(parseCapabilityArtifact(validArtifact()).schemaVersion).toBe('1');
  });

  it('rejects a missing schema version', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(validArtifact({ schemaVersion: undefined })),
    );

    expectIssue(issues, 'schemaVersion', /is required/);
  });

  it('rejects an unsupported schema version without reporting shape errors as well', () => {
    const issues = issuesOf(() => parseCapabilityArtifact(validArtifact({ schemaVersion: '2' })));

    expect(issues).toHaveLength(1);
    expectIssue(issues, 'schemaVersion', /unsupported artifact schema version/);
  });
});

describe('capability identity', () => {
  it('rejects a missing id', () => {
    const issues = issuesOf(() => parseCapabilityArtifact(validArtifact({ id: undefined })));

    expectIssue(issues, 'id', /expected string/);
  });

  it('rejects an id that is not kebab-case', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(validArtifact({ id: 'Lookup Customer' })),
    );

    expectIssue(issues, 'id', /kebab-case/);
  });

  it('rejects a capability version that is not a positive integer', () => {
    const issues = issuesOf(() => parseCapabilityArtifact(validArtifact({ version: 0 })));

    expectIssue(issues, 'version', /positive integer/);
  });

  it('keeps the capability version independent of the schema version', () => {
    const artifact = parseCapabilityArtifact(validArtifact({ version: 7 }));

    expect(artifact.version).toBe(7);
    expect(artifact.schemaVersion).toBe('1');
  });

  it('rejects an unknown top-level key rather than silently dropping it', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(validArtifact({ discoveryTranscript: 'a model said this' })),
    );

    expectIssue(issues, '', /Unrecognized key: "discoveryTranscript"/);
  });

  it('requires a success condition', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(validArtifact({ successCondition: undefined })),
    );

    expectIssue(issues, 'successCondition', /expected object|Invalid input/);
  });
});

describe('inputs', () => {
  it('accepts every supported value type', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({
        inputs: [
          { name: 'reference', type: 'string', required: true, description: 'A reference.' },
          { name: 'amount', type: 'number', required: false, description: 'An amount.' },
          { name: 'includeClosed', type: 'boolean', required: false, description: 'A flag.' },
        ],
        steps: [
          {
            id: 'enter-reference',
            type: 'fill',
            target: customerReferenceTarget(),
            value: { source: 'input', name: 'reference' },
          },
          {
            id: 'enter-amount',
            type: 'fill',
            target: customerReferenceTarget(),
            value: { source: 'input', name: 'amount' },
          },
          {
            id: 'enter-include-closed',
            type: 'fill',
            target: customerReferenceTarget(),
            value: { source: 'input', name: 'includeClosed' },
          },
        ],
      }),
    );

    expect(artifact.inputs.map((input) => input.type)).toEqual(['string', 'number', 'boolean']);
  });

  it('defaults an input to not sensitive', () => {
    const artifact = parseCapabilityArtifact(validArtifact());

    expect(artifact.inputs[0]?.sensitive).toBe(false);
  });

  it('rejects an unsupported input type', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        validArtifact({
          inputs: [
            {
              name: 'customerReference',
              type: 'date',
              required: true,
              description: 'A reference.',
            },
          ],
        }),
      ),
    );

    expectIssue(issues, 'inputs[0].type', /must be one of string, number, boolean/);
  });

  it('rejects duplicate input names', () => {
    const input = {
      name: 'customerReference',
      type: 'string',
      required: true,
      description: 'A reference.',
    };
    const issues = issuesOf(() =>
      parseCapabilityArtifact(validArtifact({ inputs: [input, { ...input }] })),
    );

    expectIssue(issues, 'inputs[1].name', /duplicate input name/);
  });

  it('rejects an input no step reads', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        validArtifact({
          inputs: [
            {
              name: 'customerReference',
              type: 'string',
              required: true,
              description: 'A reference.',
            },
            { name: 'unusedFlag', type: 'boolean', required: false, description: 'Unused.' },
          ],
        }),
      ),
    );

    expectIssue(issues, 'inputs[1].name', /no step uses it/);
  });
});

describe('outputs', () => {
  it('rejects duplicate output names', () => {
    const output = {
      name: 'accountStatus',
      type: 'string',
      description: 'Account status.',
    };
    const issues = issuesOf(() =>
      parseCapabilityArtifact(validArtifact({ outputs: [output, { ...output }] })),
    );

    expectIssue(issues, 'outputs[1].name', /duplicate output name/);
  });

  it('rejects an output no extract step produces', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        validArtifact({
          outputs: [
            { name: 'accountStatus', type: 'string', description: 'Account status.' },
            { name: 'openTicketCount', type: 'number', description: 'Open tickets.' },
          ],
        }),
      ),
    );

    expectIssue(issues, 'outputs[1].name', /no extract step produces it/);
  });
});

describe('steps', () => {
  it('rejects a capability with no steps', () => {
    const issues = issuesOf(() => parseCapabilityArtifact(minimalArtifact({ steps: [] })));

    expectIssue(issues, 'steps', /at least one step/);
  });

  it('rejects an unsupported step type', () => {
    const issues = issuesOf(() =>
      parseWithSteps([{ id: 'press-key', type: 'keypress', key: 'Enter' }]),
    );

    expectIssue(issues, 'steps[0].type', /supported step types/);
  });

  it('rejects duplicate step ids', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        { id: 'open-search', type: 'navigate', url: 'https://demo.replay-ai.test/a' },
        { id: 'open-search', type: 'navigate', url: 'https://demo.replay-ai.test/b' },
      ]),
    );

    expectIssue(issues, 'steps[1].id', /duplicate step id/);
  });

  it('parses a navigate step and defaults its risk to safe', () => {
    const artifact = parseCapabilityArtifact(minimalArtifact());
    const step = artifact.steps[0];

    expect(step).toMatchObject({ type: 'navigate', risk: 'safe' });
  });

  it('rejects a navigate step whose url is not absolute', () => {
    const issues = issuesOf(() =>
      parseWithSteps([{ id: 'open-search', type: 'navigate', url: '/support/customers' }]),
    );

    expectIssue(issues, 'steps[0].url', /absolute URL/);
  });

  it('parses a click step with a declared risk', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({
        steps: [
          {
            id: 'submit-customer-search',
            type: 'click',
            target: searchButtonTarget(),
            risk: 'risky',
          },
        ],
      }),
    );

    expect(artifact.steps[0]).toMatchObject({ type: 'click', risk: 'risky' });
  });

  it('rejects an unknown risk level', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        { id: 'submit-search', type: 'click', target: searchButtonTarget(), risk: 'harmless' },
      ]),
    );

    expectIssue(issues, 'steps[0].risk', /Invalid option|expected one of/);
  });

  it('parses a fill step carrying a literal value', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({
        steps: [
          {
            id: 'choose-account-type',
            type: 'fill',
            target: customerReferenceTarget(),
            value: { source: 'literal', value: 'Checking' },
          },
        ],
      }),
    );

    expect(artifact.steps[0]).toMatchObject({
      type: 'fill',
      value: { source: 'literal', value: 'Checking' },
    });
  });

  it('parses a fill step carrying a parameter reference', () => {
    const artifact = parseCapabilityArtifact(validArtifact());

    expect(artifact.steps[1]).toMatchObject({
      type: 'fill',
      value: { source: 'input', name: 'customerReference' },
    });
  });

  it('parses an extract step assigning a declared output', () => {
    const artifact = parseCapabilityArtifact(validArtifact());

    expect(artifact.steps[3]).toMatchObject({ type: 'extract', output: 'accountStatus' });
  });

  it('parses a wait step whose condition is state-based', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({
        steps: [
          {
            id: 'await-search-result',
            type: 'wait',
            condition: { type: 'targetVisible', target: summaryTarget() },
          },
        ],
      }),
    );

    expect(artifact.steps[0]).toMatchObject({
      type: 'wait',
      condition: { type: 'targetVisible' },
    });
  });

  it('has no way to express a fixed sleep', () => {
    const issues = issuesOf(() => parseWithSteps([{ id: 'pause', type: 'sleep', ms: 3000 }]));

    expectIssue(issues, 'steps[0].type', /supported step types/);
  });

  it('parses a checkpoint step', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({
        steps: [{ id: 'confirm-summary', type: 'checkpoint', condition: successCondition() }],
      }),
    );

    expect(artifact.steps[0]).toMatchObject({ type: 'checkpoint' });
  });

  it('rejects a field that belongs to a different step type', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        {
          id: 'submit-search',
          type: 'click',
          target: searchButtonTarget(),
          value: { source: 'literal', value: 'Checking' },
        },
      ]),
    );

    expectIssue(issues, 'steps[0]', /Unrecognized key: "value"/);
  });
});

describe('parameter and output references', () => {
  it('rejects a value source that is not literal or input', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        {
          id: 'enter-reference',
          type: 'fill',
          target: customerReferenceTarget(),
          value: { source: 'environment', name: 'CUSTOMER_REFERENCE' },
        },
      ]),
    );

    expectIssue(issues, 'steps[0].value.source', /Invalid discriminator value/);
  });

  it('rejects a reference to an input the capability does not declare', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        validArtifact({
          steps: [
            {
              id: 'enter-reference',
              type: 'fill',
              target: customerReferenceTarget(),
              value: { source: 'input', name: 'unknownMember' },
            },
            {
              id: 'read-account-status',
              type: 'extract',
              target: summaryTarget(),
              output: 'accountStatus',
            },
          ],
        }),
      ),
    );

    expectIssue(issues, 'steps[0].value.name', /no input named "unknownMember"/);
  });

  it('rejects an extract step assigning an output the capability does not declare', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        validArtifact({
          steps: [
            {
              id: 'enter-reference',
              type: 'fill',
              target: customerReferenceTarget(),
              value: { source: 'input', name: 'customerReference' },
            },
            {
              id: 'read-balance',
              type: 'extract',
              target: summaryTarget(),
              output: 'balance',
            },
          ],
        }),
      ),
    );

    expectIssue(issues, 'steps[1].output', /no output named "balance"/);
  });
});

describe('targets', () => {
  it('keeps the recorded strategy order', () => {
    const artifact = parseCapabilityArtifact(validArtifact());
    const step = artifact.steps[1];

    expect(step?.type).toBe('fill');
    if (step?.type !== 'fill') {
      throw new Error('expected a fill step');
    }
    expect(step.target.strategies.map((strategy) => strategy.kind)).toEqual([
      'role',
      'label',
      'css',
    ]);
  });

  it('drops absent optional locator fields instead of storing them as null', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({
        steps: [
          {
            id: 'submit-search',
            type: 'click',
            target: {
              description: 'Search Button',
              strategies: [{ kind: 'role', role: 'button' }],
            },
          },
        ],
      }),
    );
    const step = artifact.steps[0];

    if (step?.type !== 'click') {
      throw new Error('expected a click step');
    }
    expect(step.target.strategies[0]).toEqual({ kind: 'role', role: 'button' });
  });

  it('rejects a target with no strategies', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        {
          id: 'submit-search',
          type: 'click',
          target: { description: 'Search Button', strategies: [] },
        },
      ]),
    );

    expectIssue(issues, 'steps[0].target.strategies', /at least one locator strategy/);
  });

  it('rejects a locator strategy the surface does not support', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        {
          id: 'submit-search',
          type: 'click',
          target: {
            description: 'Search Button',
            strategies: [{ kind: 'xpath', expression: '//button[1]' }],
          },
        },
      ]),
    );

    expectIssue(issues, 'steps[0].target.strategies[0].kind', /Invalid discriminator value/);
  });

  it('rejects a role that is not in the surface role vocabulary', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        {
          id: 'submit-search',
          type: 'click',
          target: {
            description: 'Search Button',
            strategies: [{ kind: 'role', role: 'pushbutton' }],
          },
        },
      ]),
    );

    expectIssue(issues, 'steps[0].target.strategies[0].role', /Invalid option|expected one of/);
  });
});

describe('checkpoints', () => {
  it('parses every checkpoint type', () => {
    const conditions = [
      { type: 'targetVisible', target: summaryTarget() },
      { type: 'targetContainsText', target: summaryTarget(), text: 'Active' },
      { type: 'textVisible', text: 'Customer Summary' },
      { type: 'urlMatches', pattern: '^https://demo\\.replay-ai\\.test/support/customers/' },
    ];

    for (const condition of conditions) {
      const artifact = parseCapabilityArtifact(minimalArtifact({ successCondition: condition }));
      expect(artifact.successCondition).toEqual(condition);
    }
  });

  it('rejects an unknown checkpoint type', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        minimalArtifact({ successCondition: { type: 'elementCount', count: 2 } }),
      ),
    );

    expectIssue(issues, 'successCondition.type', /Invalid discriminator value/);
  });

  it('rejects a url pattern that is not a valid regular expression', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        minimalArtifact({ successCondition: { type: 'urlMatches', pattern: '([a-z' } }),
      ),
    );

    expectIssue(issues, 'successCondition.pattern', /valid regular expression/);
  });
});

describe('business outcomes', () => {
  it('parses a declared outcome with its condition', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({
        businessOutcomes: [
          {
            code: 'CUSTOMER_NOT_FOUND',
            description: 'No customer matches the supplied reference.',
            condition: { type: 'textVisible', text: 'No Customer Matches That Reference' },
          },
        ],
      }),
    );

    expect(artifact.businessOutcomes[0]?.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('rejects an outcome code that is not upper snake case', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        minimalArtifact({
          businessOutcomes: [
            {
              code: 'customer not found',
              description: 'No customer matches the supplied reference.',
              condition: { type: 'textVisible', text: 'No Customer Matches That Reference' },
            },
          ],
        }),
      ),
    );

    expectIssue(issues, 'businessOutcomes[0].code', /upper snake case/);
  });

  it('rejects an outcome whose condition is not a checkpoint', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        minimalArtifact({
          businessOutcomes: [
            {
              code: 'CUSTOMER_NOT_FOUND',
              description: 'No customer matches the supplied reference.',
              condition: { type: 'textVisible', value: 'No Customer Matches That Reference' },
            },
          ],
        }),
      ),
    );

    expect(issues.some((issue) => issue.path.startsWith('businessOutcomes[0].condition'))).toBe(
      true,
    );
  });

  it('rejects duplicate outcome codes', () => {
    const outcome = {
      code: 'CUSTOMER_NOT_FOUND',
      description: 'No customer matches the supplied reference.',
      condition: { type: 'textVisible', text: 'No Customer Matches That Reference' },
    };
    const issues = issuesOf(() =>
      parseCapabilityArtifact(minimalArtifact({ businessOutcomes: [outcome, { ...outcome }] })),
    );

    expectIssue(issues, 'businessOutcomes[1].code', /duplicate business outcome code/);
  });
});

describe('execution overrides', () => {
  it('parses a timeout and a retry', () => {
    const artifact = parseCapabilityArtifact(
      minimalArtifact({
        steps: [
          {
            id: 'open-customer-search',
            type: 'navigate',
            url: 'https://demo.replay-ai.test/support/customers',
            execution: { timeoutMs: 20_000, retry: { maxAttempts: 2 } },
          },
        ],
      }),
    );

    expect(artifact.steps[0]?.execution).toEqual({
      timeoutMs: 20_000,
      retry: { maxAttempts: 2 },
    });
  });

  it('rejects a timeout that is not a positive whole number of milliseconds', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        {
          id: 'open-customer-search',
          type: 'navigate',
          url: 'https://demo.replay-ai.test/support/customers',
          execution: { timeoutMs: -1 },
        },
      ]),
    );

    expectIssue(issues, 'steps[0].execution.timeoutMs', /greater than zero/);
  });

  it('rejects a retry count outside the supported range', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        {
          id: 'open-customer-search',
          type: 'navigate',
          url: 'https://demo.replay-ai.test/support/customers',
          execution: { retry: { maxAttempts: 50 } },
        },
      ]),
    );

    expectIssue(issues, 'steps[0].execution.retry.maxAttempts', /at most 3 attempts/);
  });

  it('rejects a retry on an irreversible step', () => {
    const issues = issuesOf(() =>
      parseWithSteps([
        {
          id: 'confirm-transfer',
          type: 'click',
          target: searchButtonTarget(),
          risk: 'irreversible',
          execution: { retry: { maxAttempts: 2 } },
        },
      ]),
    );

    expectIssue(issues, 'steps[0].execution.retry', /must not declare a retry/);
  });
});

describe('metadata', () => {
  it('rejects a timestamp that is not ISO 8601', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        validArtifact({ metadata: { createdAt: 'yesterday', updatedAt: 'yesterday' } }),
      ),
    );

    expectIssue(issues, 'metadata.createdAt', /ISO 8601/);
  });

  it('rejects an update that predates creation', () => {
    const issues = issuesOf(() =>
      parseCapabilityArtifact(
        validArtifact({
          metadata: {
            createdAt: '2026-08-18T00:00:00.000Z',
            updatedAt: '2026-08-17T00:00:00.000Z',
          },
        }),
      ),
    );

    expectIssue(issues, 'metadata.updatedAt', /not be earlier/);
  });
});
