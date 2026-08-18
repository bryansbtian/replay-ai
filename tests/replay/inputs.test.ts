import { describe, expect, it } from 'vitest';

import { parseCapabilityArtifact } from '../../src/artifacts/index.js';
import {
  InvocationInputError,
  resolveParameter,
  validateInvocationInputs,
} from '../../src/replay/index.js';

import { artifact, fullArtifact, memberIdTarget, searchButtonTarget } from './support/artifacts.js';

/**
 * Invocation validation and parameter resolution: everything that happens before the
 * surface is touched, and the one rule that decides what a step actually types.
 */

function issuesOf(run: () => unknown): { name: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof InvocationInputError) {
      return error.issues.map((issue) => ({ name: issue.name, message: issue.message }));
    }
    throw error;
  }
  throw new Error('expected validation to fail');
}

describe('invocation input validation', () => {
  it('accepts a valid required input', () => {
    const resolved = validateInvocationInputs(fullArtifact(), { memberId: '12345' });

    expect(resolved.get('memberId')).toBe('12345');
  });

  it('rejects a missing required input', () => {
    const issues = issuesOf(() => validateInvocationInputs(fullArtifact(), {}));

    expect(issues).toEqual([{ name: 'memberId', message: 'is required and must be a string' }]);
  });

  it('rejects a value of the wrong type instead of coercing it', () => {
    const issues = issuesOf(() => validateInvocationInputs(fullArtifact(), { memberId: 12345 }));

    expect(issues).toEqual([{ name: 'memberId', message: 'must be a string, received a number' }]);
  });

  it('rejects an input the capability does not declare', () => {
    const issues = issuesOf(() =>
      validateInvocationInputs(fullArtifact(), { memberId: '12345', tenant: 'acme' }),
    );

    expect(issues).toEqual([{ name: 'tenant', message: 'is not an input of this capability' }]);
  });

  it('reports every problem at once', () => {
    const issues = issuesOf(() => validateInvocationInputs(fullArtifact(), { region: 'eu' }));

    expect(issues.map((issue) => issue.name).sort()).toEqual(['memberId', 'region']);
  });

  it('never echoes the value it rejected', () => {
    // An invalid value can still be a secret, so the report names the input and stops.
    let message = '';
    try {
      validateInvocationInputs(fullArtifact(), {
        memberId: '12345',
        password: 'super-secret-value',
      });
    } catch (error) {
      if (!(error instanceof InvocationInputError)) {
        throw error;
      }
      message = `${error.message}${JSON.stringify(error.issues)}`;
    }

    expect(message).toContain('password');
    expect(message).not.toContain('super-secret-value');
  });

  it('checks each declared type without coercion', () => {
    const typed = multiInputArtifact();

    expect(() =>
      validateInvocationInputs(typed, { memberId: '1', amount: 12.5, includeClosed: true }),
    ).not.toThrow();
    expect(
      issuesOf(() =>
        validateInvocationInputs(typed, { memberId: '1', amount: '12.5', includeClosed: true }),
      ),
    ).toEqual([{ name: 'amount', message: 'must be a number, received a string' }]);
    expect(
      issuesOf(() =>
        validateInvocationInputs(typed, { memberId: '1', amount: 1, includeClosed: 'yes' }),
      ),
    ).toEqual([{ name: 'includeClosed', message: 'must be a boolean, received a string' }]);
  });

  it('rejects a number that is not finite', () => {
    const issues = issuesOf(() =>
      validateInvocationInputs(multiInputArtifact(), {
        memberId: '1',
        amount: Number.NaN,
        includeClosed: false,
      }),
    );

    expect(issues).toEqual([{ name: 'amount', message: 'must be a number, received a number' }]);
  });

  it('rejects null, which is neither a value nor an omission', () => {
    const issues = issuesOf(() => validateInvocationInputs(fullArtifact(), { memberId: null }));

    expect(issues).toEqual([{ name: 'memberId', message: 'must be a string, received null' }]);
  });

  it('resolves an omitted optional input to the empty string, which clears the field', () => {
    const optional = optionalInputArtifact();

    const resolved = validateInvocationInputs(optional, {});

    expect(resolved.get('memberNote')).toBe('');
  });

  it('accepts a supplied optional input', () => {
    const resolved = validateInvocationInputs(optionalInputArtifact(), { memberNote: 'Follow Up' });

    expect(resolved.get('memberNote')).toBe('Follow Up');
  });
});

describe('parameter resolution', () => {
  it('resolves a literal to the stored text', () => {
    const resolution = resolveParameter({ source: 'literal', value: 'Savings' }, new Map());

    expect(resolution).toEqual({ resolved: true, value: 'Savings' });
  });

  it('resolves a reference to the supplied invocation value', () => {
    const inputs = validateInvocationInputs(fullArtifact(), { memberId: '12345' });

    expect(resolveParameter({ source: 'input', name: 'memberId' }, inputs)).toEqual({
      resolved: true,
      value: '12345',
    });
  });

  it('renders a non-string input without changing it', () => {
    const inputs = new Map<string, string | number | boolean>([
      ['amount', 12.5],
      ['includeClosed', false],
    ]);

    expect(resolveParameter({ source: 'input', name: 'amount' }, inputs)).toEqual({
      resolved: true,
      value: '12.5',
    });
    expect(resolveParameter({ source: 'input', name: 'includeClosed' }, inputs)).toEqual({
      resolved: true,
      value: 'false',
    });
  });

  it('reports a reference it cannot resolve rather than substituting anything', () => {
    expect(resolveParameter({ source: 'input', name: 'memberId' }, new Map())).toEqual({
      resolved: false,
      unresolved: { inputName: 'memberId' },
    });
  });
});

function multiInputArtifact() {
  return artifact({
    inputs: [
      { name: 'memberId', type: 'string', required: true, description: 'The member id.' },
      { name: 'amount', type: 'number', required: true, description: 'A transfer amount.' },
      {
        name: 'includeClosed',
        type: 'boolean',
        required: true,
        description: 'Whether closed accounts are included.',
      },
    ],
    outputs: [],
    steps: [
      {
        id: 'enter-member-id',
        type: 'fill',
        target: memberIdTarget(),
        value: { source: 'input', name: 'memberId' },
      },
      {
        id: 'enter-amount',
        type: 'fill',
        target: memberIdTarget(),
        value: { source: 'input', name: 'amount' },
      },
      {
        id: 'enter-include-closed',
        type: 'fill',
        target: memberIdTarget(),
        value: { source: 'input', name: 'includeClosed' },
      },
      { id: 'submit-search', type: 'click', target: searchButtonTarget() },
    ],
  });
}

function optionalInputArtifact() {
  return artifact({
    inputs: [
      { name: 'memberNote', type: 'string', required: false, description: 'An optional note.' },
    ],
    outputs: [],
    steps: [
      {
        id: 'enter-note',
        type: 'fill',
        target: memberIdTarget(),
        value: { source: 'input', name: 'memberNote' },
      },
    ],
  });
}

describe('the artifacts these suites replay', () => {
  it('are validated by the real Phase 3 validator', () => {
    expect(() => parseCapabilityArtifact({ ...fullArtifact(), steps: [] })).toThrow();
  });
});
