import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ArtifactValidationError,
  deserializeCapabilityArtifact,
  parseCapabilityArtifact,
  serializeCapabilityArtifact,
} from '../../src/artifacts/index.js';

import { issuesOf, validArtifact } from './support/artifacts.js';

const EXAMPLE_PATH = join('tests', 'fixtures', 'capabilities', 'lookup-demo-customer.json');

/**
 * Reads a committed file with its line endings normalized.
 *
 * The serializer emits `\n`, and a Windows checkout configured with `core.autocrlf`
 * hands back `\r\n` for the same committed bytes. Comparing raw would test which
 * platform ran the suite rather than whether the artifact is canonical, so the newline
 * convention is normalized and everything else about the document is still compared
 * exactly: key order, indentation, spacing, and the trailing newline all still have to
 * match what `serializeCapabilityArtifact` produces.
 */
function readCommitted(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

describe('serializeCapabilityArtifact', () => {
  it('round trips an artifact unchanged', () => {
    const artifact = parseCapabilityArtifact(validArtifact());

    const restored = deserializeCapabilityArtifact(serializeCapabilityArtifact(artifact));

    expect(restored).toEqual(artifact);
  });

  it('writes indented JSON ending in a newline so a diff stays readable', () => {
    const json = serializeCapabilityArtifact(parseCapabilityArtifact(validArtifact()));

    expect(json.startsWith('{\n  "schemaVersion": "1",')).toBe(true);
    expect(json.endsWith('}\n')).toBe(true);
  });

  it('produces the same text for two artifacts whose keys were written in a different order', () => {
    const artifact = validArtifact();
    const reordered = Object.fromEntries(Object.entries(artifact).reverse());

    expect(serializeCapabilityArtifact(parseCapabilityArtifact(reordered))).toBe(
      serializeCapabilityArtifact(parseCapabilityArtifact(artifact)),
    );
  });

  it('keeps a Phase 2 target intact through a round trip', () => {
    const artifact = parseCapabilityArtifact(validArtifact());
    const restored = deserializeCapabilityArtifact(serializeCapabilityArtifact(artifact));
    const step = restored.steps[1];

    if (step?.type !== 'fill') {
      throw new Error('expected a fill step');
    }
    expect(step.target).toEqual({
      description: 'Customer Reference Field',
      strategies: [
        { kind: 'role', role: 'textbox', name: 'Customer Reference' },
        { kind: 'label', text: 'Customer Reference' },
        { kind: 'css', selector: '#customer-reference' },
      ],
    });
  });

  it('refuses to serialize an artifact that would not parse back', () => {
    const artifact = parseCapabilityArtifact(validArtifact());
    const broken = {
      ...artifact,
      steps: artifact.steps.map((step) => ({ ...step, id: 'repeated-step' })),
    };

    expect(() => serializeCapabilityArtifact(broken)).toThrow(ArtifactValidationError);
  });
});

describe('deserializeCapabilityArtifact', () => {
  it('reports malformed JSON as an artifact problem rather than throwing a syntax error', () => {
    const issues = issuesOf(() => deserializeCapabilityArtifact('{ "schemaVersion": '));

    expect(issues[0]?.message).toMatch(/is not valid JSON/);
  });

  it('names the source of malformed JSON when one was given', () => {
    const failure = (): unknown => {
      return deserializeCapabilityArtifact('not json', { source: 'capabilities/broken.json' });
    };

    expect(failure).toThrow(/capabilities\/broken\.json/);
  });

  it('validates the parsed document instead of trusting it', () => {
    const issues = issuesOf(() => deserializeCapabilityArtifact('{"schemaVersion":"1"}'));

    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('the committed example artifact', () => {
  it('parses, and is already in the canonical serialized form', () => {
    const json = readCommitted(EXAMPLE_PATH);

    const artifact = deserializeCapabilityArtifact(json, { source: EXAMPLE_PATH });

    expect(artifact.name).toBe('Lookup Demo Customer');
    expect(serializeCapabilityArtifact(artifact)).toBe(json);
  });

  it('demonstrates the concepts a Phase 4 replay fixture needs', () => {
    const artifact = deserializeCapabilityArtifact(readFileSync(EXAMPLE_PATH, 'utf8'));

    expect(artifact.inputs).toHaveLength(1);
    expect(artifact.outputs).toHaveLength(2);
    expect(artifact.businessOutcomes[0]?.code).toBe('CUSTOMER_NOT_FOUND');
    expect(new Set(artifact.steps.map((step) => step.type))).toEqual(
      new Set(['navigate', 'checkpoint', 'fill', 'click', 'wait', 'extract']),
    );
  });

  it('contains no credential-like content', () => {
    const json = readFileSync(EXAMPLE_PATH, 'utf8');

    expect(json).not.toMatch(/password|secret|token|api[-_]?key|cookie/i);
  });
});
