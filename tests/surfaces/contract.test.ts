import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTarget, type ComputerSurface, type Target } from '../../src/surfaces/index.js';
import type { PlaywrightSession } from '../../src/surfaces/playwright/index.js';

import { FIXTURE_URL, openSurface } from './support/fixture.js';

/**
 * The Phase 2 proof: a whole workflow expressed against `ComputerSurface` alone.
 *
 * `runSearchWorkflow` takes a surface and a value. It never mentions a browser, a page,
 * a locator, or Playwright, so the same function would run against any future surface
 * implementation. Choosing Playwright happens once, in the fixture plumbing below.
 */

const SEARCH_FIELD: Target = createTarget('Search Field', [
  { kind: 'role', role: 'textbox', name: 'Search Term' },
  { kind: 'label', text: 'Search Term' },
  { kind: 'placeholder', text: 'Enter A Search Term' },
  { kind: 'attribute', attribute: 'data-testid', value: 'query-input' },
  { kind: 'css', selector: '#query' },
]);

const SEARCH_BUTTON: Target = createTarget('Search Button', [
  { kind: 'role', role: 'button', name: 'Search' },
  { kind: 'attribute', attribute: 'data-testid', value: 'search-button' },
  { kind: 'css', selector: '#search-button' },
]);

const RESULT_TEXT: Target = createTarget('Result Text', [
  { kind: 'attribute', attribute: 'data-testid', value: 'result' },
  { kind: 'css', selector: '#result' },
]);

interface WorkflowOutcome {
  readonly result: string;
  readonly steps: readonly string[];
}

async function runSearchWorkflow(
  surface: ComputerSurface,
  searchTerm: string,
): Promise<WorkflowOutcome> {
  const steps: string[] = [];

  const opened = await surface.navigate(FIXTURE_URL);
  steps.push(opened.action);

  const filled = await surface.fill(SEARCH_FIELD, searchTerm);
  steps.push(filled.action);

  const clicked = await surface.click(SEARCH_BUTTON);
  steps.push(clicked.action);

  const extracted = await surface.extract(RESULT_TEXT);
  return { result: extracted.value, steps };
}

let surface: ComputerSurface;
let session: PlaywrightSession;

beforeAll(async () => {
  const fixture = await openSurface();
  surface = fixture.surface;
  session = fixture.session;
});

afterAll(async () => {
  await session.close();
});

describe('a workflow driven entirely through ComputerSurface', () => {
  it('opens a page, enters a value, submits, and reads the result', async () => {
    const outcome = await runSearchWorkflow(surface, 'Widgets');

    expect(outcome.steps).toEqual(['navigate', 'fill', 'click']);
    expect(outcome.result).toBe('Result For Widgets');
  });

  it('runs again with a different value using the same target definitions', async () => {
    const first = await runSearchWorkflow(surface, 'Sprockets');
    const second = await runSearchWorkflow(surface, 'Gaskets');

    expect(first.result).toBe('Result For Sprockets');
    expect(second.result).toBe('Result For Gaskets');
  });

  it('observes the surface changing as the workflow progresses', async () => {
    await surface.navigate(FIXTURE_URL);
    const before = await surface.observe();

    await runSearchWorkflow(surface, 'Widgets');
    const after = await surface.observe();

    expect(before.textSummary).toContain('No Search Yet');
    expect(after.textSummary).toContain('Result For Widgets');
    expect(after.controls.map((control) => control.name)).toContain('Search');
  });

  it('captures evidence of the finished state through the same contract', async () => {
    await runSearchWorkflow(surface, 'Widgets');

    const shot = await surface.screenshot();

    expect(shot.format).toBe('png');
    expect(shot.byteLength).toBeGreaterThan(0);
  });
});
