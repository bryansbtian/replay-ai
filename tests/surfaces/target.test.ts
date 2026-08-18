import { describe, expect, it } from 'vitest';

import {
  createTarget,
  DEFAULT_STRATEGY_ORDER,
  InvalidTargetError,
} from '../../src/surfaces/index.js';
import type { LocatorStrategy } from '../../src/surfaces/index.js';

const ALL_KINDS: readonly LocatorStrategy[] = [
  { kind: 'css', selector: '#query' },
  { kind: 'text', text: 'Search Term' },
  { kind: 'attribute', attribute: 'data-testid', value: 'query-input' },
  { kind: 'placeholder', text: 'Enter A Search Term' },
  { kind: 'label', text: 'Search Term' },
  { kind: 'role', role: 'textbox', name: 'Search Term' },
];

describe('createTarget', () => {
  it('stores strategies in the default priority order regardless of input order', () => {
    const target = createTarget('Search Field', ALL_KINDS);

    expect(target.strategies.map((strategy) => strategy.kind)).toEqual(DEFAULT_STRATEGY_ORDER);
  });

  it('keeps the caller order when asked to', () => {
    const target = createTarget('Search Field', ALL_KINDS, { ordering: 'as-given' });

    expect(target.strategies.map((strategy) => strategy.kind)).toEqual([
      'css',
      'text',
      'attribute',
      'placeholder',
      'label',
      'role',
    ]);
  });

  it('keeps two strategies of the same kind in the order they were supplied', () => {
    const target = createTarget('Search Field', [
      { kind: 'css', selector: '#first' },
      { kind: 'css', selector: '#second' },
    ]);

    expect(target.strategies).toEqual([
      { kind: 'css', selector: '#first' },
      { kind: 'css', selector: '#second' },
    ]);
  });

  it('does not mutate the array it was given', () => {
    const supplied = [...ALL_KINDS];

    createTarget('Search Field', supplied);

    expect(supplied[0]).toEqual({ kind: 'css', selector: '#query' });
  });

  it('rejects a target with no strategies instead of failing at resolution time', () => {
    expect(() => createTarget('Search Field', [])).toThrow(InvalidTargetError);
    expect(() => createTarget('Search Field', [])).toThrow(/at least one strategy/);
  });
});
