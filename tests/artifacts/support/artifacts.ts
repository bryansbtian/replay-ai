import { expect } from 'vitest';

import { ArtifactValidationError, type ArtifactIssue } from '../../../src/artifacts/index.js';

/**
 * Fixture plumbing for the artifact suites.
 *
 * Artifacts are built as plain JSON-shaped data rather than typed objects, because that
 * is what validation actually receives: a document read off disk. A test can then break
 * one field the way a bad file would, instead of being stopped by the compiler.
 */

export type JsonObject = Record<string, unknown>;

export function customerReferenceTarget(): JsonObject {
  return {
    description: 'Customer Reference Field',
    strategies: [
      { kind: 'role', role: 'textbox', name: 'Customer Reference' },
      { kind: 'label', text: 'Customer Reference' },
      { kind: 'css', selector: '#customer-reference' },
    ],
  };
}

export function searchButtonTarget(): JsonObject {
  return {
    description: 'Search Button',
    strategies: [{ kind: 'role', role: 'button', name: 'Search', exact: true }],
  };
}

export function summaryTarget(): JsonObject {
  return {
    description: 'Customer Summary Heading',
    strategies: [{ kind: 'role', role: 'heading', name: 'Customer Summary' }],
  };
}

export function successCondition(): JsonObject {
  return { type: 'targetVisible', target: summaryTarget() };
}

/**
 * A complete, valid artifact exercising every relationship the semantic rules check: an
 * input a step reads, an output a step writes, and a required success condition.
 */
export function validArtifact(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: '1',
    id: 'lookup-demo-customer',
    name: 'Lookup Demo Customer',
    description: 'Looks up a demo customer by reference and reads their account status.',
    version: 1,
    application: {
      name: 'Demo Support Console',
      entryPoint: 'https://demo.replay-ai.test',
    },
    inputs: [
      {
        name: 'customerReference',
        type: 'string',
        required: true,
        description: 'Reference code printed on the demo customer record.',
      },
    ],
    outputs: [
      {
        name: 'accountStatus',
        type: 'string',
        description: 'Account status shown on the customer summary.',
      },
    ],
    steps: [
      {
        id: 'open-customer-search',
        type: 'navigate',
        url: 'https://demo.replay-ai.test/support/customers',
      },
      {
        id: 'enter-customer-reference',
        type: 'fill',
        target: customerReferenceTarget(),
        value: { source: 'input', name: 'customerReference' },
      },
      { id: 'submit-customer-search', type: 'click', target: searchButtonTarget() },
      {
        id: 'read-account-status',
        type: 'extract',
        target: {
          description: 'Account Status Value',
          strategies: [{ kind: 'attribute', attribute: 'data-field', value: 'account-status' }],
        },
        output: 'accountStatus',
      },
    ],
    successCondition: successCondition(),
    metadata: {
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
    ...overrides,
  };
}

/** A minimal artifact with no inputs, outputs, or optional sections. */
export function minimalArtifact(overrides: JsonObject = {}): JsonObject {
  return validArtifact({
    inputs: [],
    outputs: [],
    steps: [
      {
        id: 'open-customer-search',
        type: 'navigate',
        url: 'https://demo.replay-ai.test/support/customers',
      },
    ],
    ...overrides,
  });
}

/** The issues a validation failure reported, or a test failure when it did not fail. */
export function issuesOf(parse: () => unknown): readonly ArtifactIssue[] {
  try {
    parse();
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected validation to fail');
}

export function expectIssue(issues: readonly ArtifactIssue[], path: string, message: RegExp): void {
  const matching = issues.filter((issue) => issue.path === path);
  expect(matching.map((issue) => issue.message).join('\n')).toMatch(message);
}
