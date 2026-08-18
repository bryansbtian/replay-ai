import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AmbiguousTargetError,
  createTarget,
  InvalidTargetError,
  TargetNotFoundError,
} from '../../src/surfaces/index.js';
import type { LocatorStrategy, LocatorStrategyKind } from '../../src/surfaces/index.js';
import {
  launchPlaywrightSession,
  LocatorResolver,
  type PlaywrightSession,
} from '../../src/surfaces/playwright/index.js';

import { FIXTURE_URL, recordingLogger, silentLogger, TEST_TIMEOUTS } from './support/fixture.js';

/**
 * The resolver is the Playwright-specific half of targeting, so this suite touches it
 * directly. Everything above it is exercised through `ComputerSurface` instead.
 */

let session: PlaywrightSession;
let resolver: LocatorResolver;

beforeAll(async () => {
  session = await launchPlaywrightSession();
  await session.page.goto(FIXTURE_URL);
  resolver = new LocatorResolver({
    page: session.page,
    timeoutMs: TEST_TIMEOUTS.locatorMs,
    logger: silentLogger(),
  });
});

afterAll(async () => {
  await session.close();
});

async function resolveWith(
  strategies: readonly LocatorStrategy[],
  ordering: 'priority' | 'as-given' = 'priority',
): Promise<LocatorStrategyKind> {
  const target = createTarget('Probe', strategies, { ordering });
  const resolved = await resolver.resolve(target);
  return resolved.strategy.kind;
}

describe('LocatorResolver strategies', () => {
  it('resolves by role and accessible name', async () => {
    await expect(resolveWith([{ kind: 'role', role: 'button', name: 'Search' }])).resolves.toBe(
      'role',
    );
  });

  it('resolves by label', async () => {
    await expect(resolveWith([{ kind: 'label', text: 'Search Term' }])).resolves.toBe('label');
  });

  it('resolves by placeholder', async () => {
    await expect(resolveWith([{ kind: 'placeholder', text: 'Enter A Search Term' }])).resolves.toBe(
      'placeholder',
    );
  });

  it('resolves by a stable attribute', async () => {
    await expect(
      resolveWith([{ kind: 'attribute', attribute: 'data-testid', value: 'query-input' }]),
    ).resolves.toBe('attribute');
  });

  it('resolves by visible text', async () => {
    await expect(resolveWith([{ kind: 'text', text: 'No Search Yet' }])).resolves.toBe('text');
  });

  it('resolves by a CSS selector as the last resort', async () => {
    await expect(resolveWith([{ kind: 'css', selector: '#query' }])).resolves.toBe('css');
  });
});

describe('LocatorResolver ordering', () => {
  it('uses the earlier strategy when several would match', async () => {
    const kind = await resolveWith([
      { kind: 'css', selector: '#query' },
      { kind: 'role', role: 'textbox', name: 'Search Term' },
    ]);

    expect(kind).toBe('role');
  });

  it('falls back to the next strategy when an earlier one matches nothing', async () => {
    const kind = await resolveWith([
      { kind: 'role', role: 'textbox', name: 'Renamed In A Redesign' },
      { kind: 'css', selector: '#query' },
    ]);

    expect(kind).toBe('css');
  });

  it('attempts strategies in the stored order when the caller pinned it', async () => {
    const kind = await resolveWith(
      [
        { kind: 'css', selector: '#query' },
        { kind: 'role', role: 'textbox', name: 'Search Term' },
      ],
      'as-given',
    );

    expect(kind).toBe('css');
  });

  it('records every attempt it made, in order', async () => {
    const target = createTarget('Search Field', [
      { kind: 'role', role: 'textbox', name: 'Renamed In A Redesign' },
      { kind: 'css', selector: '#query' },
    ]);

    const resolved = await resolver.resolve(target);

    expect(resolved.attempts).toEqual([
      expect.objectContaining({ kind: 'role', outcome: 'not-found', matchCount: 0 }),
      expect.objectContaining({ kind: 'css', outcome: 'resolved', matchCount: 1 }),
    ]);
  });
});

describe('LocatorResolver failures', () => {
  it('reports a missing target with every attempt it made', async () => {
    const target = createTarget('Missing Control', [
      { kind: 'role', role: 'button', name: 'Nowhere' },
      { kind: 'css', selector: '#nowhere' },
    ]);

    const failure = await resolver.resolve(target).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TargetNotFoundError);
    expect(failure).toMatchObject({ code: 'SURFACE_TARGET_NOT_FOUND' });
    expect(String(failure)).toContain('Missing Control');
    expect(String(failure)).toContain('role=not-found');
    expect(String(failure)).toContain('css=not-found');
  });

  it('refuses to act on an ambiguous match instead of taking the first element', async () => {
    const target = createTarget('Duplicate Button', [{ kind: 'css', selector: '.duplicate' }]);

    const failure = await resolver.resolve(target).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AmbiguousTargetError);
    expect(failure).toMatchObject({ code: 'SURFACE_TARGET_AMBIGUOUS' });
    expect(String(failure)).toContain('css=ambiguous(2)');
  });

  it('skips an ambiguous strategy and keeps looking for an unambiguous one', async () => {
    const target = createTarget('Search Button', [
      { kind: 'role', role: 'button', name: 'Duplicate' },
      { kind: 'attribute', attribute: 'data-testid', value: 'search-button' },
    ]);

    const resolved = await resolver.resolve(target);

    expect(resolved.strategy.kind).toBe('attribute');
    expect(resolved.attempts[0]).toMatchObject({ kind: 'role', outcome: 'ambiguous' });
  });

  it('rejects an attribute name that is not a valid HTML attribute name', async () => {
    const target = createTarget('Injected Attribute', [
      { kind: 'attribute', attribute: 'data-testid"] , [id', value: 'query' },
    ]);

    await expect(resolver.resolve(target)).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it('gives up on a missing target within the configured budget', async () => {
    const target = createTarget('Missing Control', [{ kind: 'css', selector: '#nowhere' }]);

    const failure = await resolver.resolve(target).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TargetNotFoundError);
    if (failure instanceof TargetNotFoundError) {
      const [attempt] = failure.attempts;
      // A millisecond of slack: the browser can report its timeout a fraction early, and
      // the point of the assertion is that the whole budget was spent, not the exact tick.
      expect(attempt?.durationMs).toBeGreaterThanOrEqual(TEST_TIMEOUTS.locatorMs - 1);
      expect(attempt?.durationMs).toBeLessThan(TEST_TIMEOUTS.locatorMs * 4);
    }
  });

  it('logs each attempt with its strategy, outcome and duration', async () => {
    const sink = recordingLogger();
    const logged = new LocatorResolver({
      page: session.page,
      timeoutMs: TEST_TIMEOUTS.locatorMs,
      logger: sink.logger,
    });

    await logged.resolve(
      createTarget('Search Button', [{ kind: 'css', selector: '#search-button' }]),
    );

    expect(sink.records()).toEqual([
      expect.objectContaining({
        message: 'locator strategy attempted',
        target: 'Search Button',
        strategy: 'css',
        outcome: 'resolved',
        matchCount: 1,
      }),
    ]);
  });
});
