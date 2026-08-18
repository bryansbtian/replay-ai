import { describe, expect, it } from 'vitest';

import type { OutputDefinition } from '../../src/artifacts/index.js';
import { OutputCollector } from '../../src/replay/index.js';

/**
 * The one conversion in the replay path: screen text into a declared output type.
 *
 * The cases below are the whole contract. Anything not listed here is refused, which is
 * the point: a value replay cannot read deterministically is an artifact to repair, not
 * something to interpret.
 */

function declare(name: string, type: OutputDefinition['type']): OutputDefinition[] {
  return [{ name, type, description: `The ${name} shown on the summary.` }];
}

describe('reading a declared output', () => {
  it('keeps a string as the text on screen, trimmed of layout whitespace', () => {
    const collector = new OutputCollector(declare('memberName', 'string'));

    expect(collector.record('memberName', '\n  Ada Lovelace  ')).toEqual({ ok: true });
    expect(collector.collect()).toEqual({ ok: true, outputs: { memberName: 'Ada Lovelace' } });
  });

  it('accepts a canonical numeric literal', () => {
    const collector = new OutputCollector(declare('savingsBalance', 'number'));

    expect(collector.record('savingsBalance', ' 5234.17 ')).toEqual({ ok: true });
    expect(collector.collect()).toEqual({ ok: true, outputs: { savingsBalance: 5234.17 } });
  });

  it('accepts a negative integer', () => {
    const collector = new OutputCollector(declare('savingsBalance', 'number'));

    collector.record('savingsBalance', '-42');

    expect(collector.collect()).toEqual({ ok: true, outputs: { savingsBalance: -42 } });
  });

  it.each(['$1,024.50', '1 024.50', '5234.17 USD', 'five', '', '1e3'])(
    'refuses to guess a number out of %s',
    (text) => {
      const collector = new OutputCollector(declare('savingsBalance', 'number'));

      const outcome = collector.record('savingsBalance', text);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.problem.code).toBe('REPLAY_OUTPUT_TYPE_MISMATCH');
      expect(outcome.problem.expected).toBe('A number Value For "savingsBalance"');
    },
  );

  it.each([
    ['true', true],
    ['false', false],
    ['True', true],
    [' FALSE ', false],
  ])('reads %s as a boolean', (text, expected) => {
    const collector = new OutputCollector(declare('includeClosed', 'boolean'));

    collector.record('includeClosed', text);

    expect(collector.collect()).toEqual({ ok: true, outputs: { includeClosed: expected } });
  });

  it('refuses anything else for a boolean', () => {
    const collector = new OutputCollector(declare('includeClosed', 'boolean'));

    const outcome = collector.record('includeClosed', 'Yes');

    expect(outcome.ok).toBe(false);
  });

  it('truncates a long value rather than putting a page into a failure message', () => {
    const collector = new OutputCollector(declare('savingsBalance', 'number'));

    const outcome = collector.record('savingsBalance', 'x'.repeat(500));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.problem.observed).toHaveLength(123);
    expect(outcome.problem.observed.endsWith('...')).toBe(true);
  });
});

describe('the output contract', () => {
  it('refuses an assignment to something the capability never declared', () => {
    const collector = new OutputCollector(declare('memberName', 'string'));

    const outcome = collector.record('accountStatus', 'Active');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.problem.code).toBe('REPLAY_OUTPUT_UNDECLARED');
  });

  it('reports a declared output that no step produced', () => {
    const collector = new OutputCollector([
      ...declare('memberName', 'string'),
      ...declare('savingsBalance', 'number'),
    ]);

    collector.record('memberName', 'Ada Lovelace');

    const collected = collector.collect();
    expect(collected.ok).toBe(false);
    if (collected.ok) {
      return;
    }
    expect(collected.problem.code).toBe('REPLAY_OUTPUT_MISSING');
    expect(collected.problem.message).toContain('savingsBalance');
  });

  it('returns an empty record for a capability that declares no outputs', () => {
    expect(new OutputCollector([]).collect()).toEqual({ ok: true, outputs: {} });
  });

  it('keeps the last value when a step reads the same output twice', () => {
    const collector = new OutputCollector(declare('memberName', 'string'));

    collector.record('memberName', 'Ada Lovelace');
    collector.record('memberName', 'Grace Hopper');

    expect(collector.collect()).toEqual({ ok: true, outputs: { memberName: 'Grace Hopper' } });
  });
});
