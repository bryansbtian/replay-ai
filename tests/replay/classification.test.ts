import { describe, expect, it } from 'vitest';

import { classifyThrown, describeCause, isRecoveryEligible } from '../../src/replay/index.js';
import {
  ActionFailedError,
  AmbiguousTargetError,
  ExtractionFailedError,
  InvalidTargetError,
  NavigationFailedError,
  SurfaceUnavailableError,
  TargetNotFoundError,
} from '../../src/surfaces/index.js';

/**
 * The boundary where a surface failure becomes a replay code.
 *
 * Two properties matter here and are asserted rather than assumed: every surface error
 * the project defines maps to something specific, and nothing that reaches a caller
 * carries a browser exception or a stack.
 */

const SURFACE_FAILURES = [
  { error: new TargetNotFoundError('Search Button', []), code: 'REPLAY_TARGET_NOT_FOUND' },
  { error: new AmbiguousTargetError('Duplicate Button', []), code: 'REPLAY_AMBIGUOUS_TARGET' },
  {
    error: new InvalidTargetError('Broken Target', 'no strategies'),
    code: 'REPLAY_TARGET_INVALID',
  },
  {
    error: new NavigationFailedError('https://demo.replay-ai.test', 'the surface responded 500'),
    code: 'REPLAY_NAVIGATION_FAILED',
  },
  {
    error: new ExtractionFailedError('Balance Value', 'the element carries no text'),
    code: 'REPLAY_OUTPUT_EXTRACTION_FAILED',
  },
  {
    error: new ActionFailedError('click', 'Search Button', 'element is not enabled'),
    code: 'REPLAY_ACTION_FAILED',
  },
  {
    error: new SurfaceUnavailableError('the page has been closed'),
    code: 'REPLAY_SURFACE_UNAVAILABLE',
  },
] as const;

describe('classifying a surface failure', () => {
  it.each(SURFACE_FAILURES)('maps $error.name to a specific code', ({ error, code }) => {
    expect(classifyThrown(error).code).toBe(code);
  });

  it('never falls back to the unclassifiable code for a surface error', () => {
    const codes = SURFACE_FAILURES.map(({ error }) => classifyThrown(error).code);

    expect(codes).not.toContain('REPLAY_UNEXPECTED_STATE');
    expect(new Set(codes).size).toBe(SURFACE_FAILURES.length);
  });

  it('reports an error it does not recognize as unclassifiable rather than guessing', () => {
    const classified = classifyThrown(new RangeError('index out of range'));

    expect(classified.code).toBe('REPLAY_UNEXPECTED_STATE');
    expect(classified.cause).toBe('RangeError: index out of range');
  });

  it('handles something thrown that is not an error at all', () => {
    expect(classifyThrown('a string was thrown').cause).toBe('Unknown Failure');
  });
});

describe('the cause a caller is given', () => {
  it('keeps the first line and drops a browser call log', () => {
    const playwrightShaped = new Error(
      [
        'locator.click: Timeout 5000ms exceeded.',
        'Call log:',
        '  - waiting for getByRole("button")',
        '  - <button disabled>Reset</button>',
      ].join('\n'),
    );

    expect(describeCause(playwrightShaped)).toBe('Error: locator.click: Timeout 5000ms exceeded.');
  });

  it('names the surface code so the origin is still identifiable', () => {
    expect(describeCause(new TargetNotFoundError('Search Button', []))).toContain(
      'SURFACE_TARGET_NOT_FOUND',
    );
  });

  it('never carries a stack trace', () => {
    const cause = describeCause(new ActionFailedError('click', 'Search Button', 'not enabled'));

    expect(cause).not.toContain('at ');
    expect(cause).not.toContain('\n');
  });
});

describe('which failures a declared recovery may be attempted for', () => {
  it.each([
    'REPLAY_CHECKPOINT_FAILED',
    'REPLAY_WAIT_TIMEOUT',
    'REPLAY_TARGET_NOT_FOUND',
    'REPLAY_AMBIGUOUS_TARGET',
    'REPLAY_ACTION_FAILED',
  ] as const)('allows a recovery after %s, which an interstitial can cause', (code) => {
    expect(isRecoveryEligible(code)).toBe(true);
  });

  it.each([
    'REPLAY_OUTPUT_MISSING',
    'REPLAY_OUTPUT_TYPE_MISMATCH',
    'REPLAY_PARAMETER_UNRESOLVED',
    'REPLAY_SURFACE_UNAVAILABLE',
    'REPLAY_STEP_TIMEOUT',
    'REPLAY_INPUTS_INVALID',
  ] as const)('refuses a recovery after %s, which no dialog explains', (code) => {
    expect(isRecoveryEligible(code)).toBe(false);
  });
});
