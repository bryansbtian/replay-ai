import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ActionFailedError,
  createTarget,
  ExtractionFailedError,
  NavigationFailedError,
  SurfaceUnavailableError,
  TargetNotFoundError,
  type ComputerSurface,
  type Target,
} from '../../src/surfaces/index.js';
import type { PlaywrightSession } from '../../src/surfaces/playwright/index.js';

import { FIXTURE_URL, openSurface, recordingLogger } from './support/fixture.js';

const SEARCH_FIELD: Target = createTarget('Search Field', [
  { kind: 'role', role: 'textbox', name: 'Search Term' },
  { kind: 'attribute', attribute: 'data-testid', value: 'query-input' },
]);

const SEARCH_BUTTON: Target = createTarget('Search Button', [
  { kind: 'role', role: 'button', name: 'Search' },
]);

const RESULT_TEXT: Target = createTarget('Result Text', [
  { kind: 'attribute', attribute: 'data-testid', value: 'result' },
]);

const DISABLED_BUTTON: Target = createTarget('Reset Button', [
  { kind: 'attribute', attribute: 'data-testid', value: 'reset-button' },
]);

const MISSING: Target = createTarget('Missing Control', [{ kind: 'css', selector: '#nowhere' }]);

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

beforeEach(async () => {
  await surface.navigate(FIXTURE_URL);
});

describe('navigate', () => {
  it('reports where it landed and how long it took', async () => {
    const result = await surface.navigate(FIXTURE_URL);

    expect(result.action).toBe('navigate');
    expect(result.url).toBe(FIXTURE_URL);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// Its own session: a failed navigation leaves the browser on an error page, and the
// next navigation on that same page can be interrupted by the browser still unwinding.
describe('a navigation that cannot complete', () => {
  it('fails with the location, a readable reason, and the underlying cause', async () => {
    const fixture = await openSurface();
    // Port 9 is the discard port: nothing listens, so the attempt fails immediately
    // rather than sitting on the navigation timeout.
    const failure = await fixture.surface
      .navigate('http://127.0.0.1:9/unreachable')
      .catch((error: unknown) => error);
    await fixture.session.close();

    expect(failure).toBeInstanceOf(NavigationFailedError);
    expect(failure).toMatchObject({ code: 'SURFACE_NAVIGATION_FAILED' });
    expect(String(failure)).toContain('127.0.0.1:9');
    if (failure instanceof NavigationFailedError) {
      expect(failure.cause).toBeInstanceOf(Error);
      // The multi-line Playwright call log stays on the cause, not in the message.
      expect(failure.message.split('\n')).toHaveLength(1);
    }
  });
});

describe('observe', () => {
  it('summarizes the current state without dumping the page', async () => {
    const observation = await surface.observe();

    expect(observation.url).toBe(FIXTURE_URL);
    expect(observation.title).toBe('Replay AI Surface Fixture');
    expect(observation.textSummary).toContain('Surface Fixture');
    expect(observation.truncated).toBe(false);
    expect(observation.textSummary).not.toContain('<button');
    expect(Date.parse(observation.capturedAt)).not.toBeNaN();
  });

  it('lists accessible controls and whether they can be used', async () => {
    const observation = await surface.observe();

    expect(observation.controls).toContainEqual({ role: 'button', name: 'Search', enabled: true });
    expect(observation.controls).toContainEqual({ role: 'button', name: 'Reset', enabled: false });
    expect(observation.controls).toContainEqual({
      role: 'textbox',
      name: 'Search Term',
      enabled: true,
    });
  });
});

describe('fill', () => {
  it('sets a value and reports which strategy resolved the control', async () => {
    const result = await surface.fill(SEARCH_FIELD, 'Widgets');

    expect(result.action).toBe('fill');
    expect(result.resolvedBy).toBe('role');
    expect((await surface.extract(SEARCH_FIELD, { kind: 'value' })).value).toBe('Widgets');
  });

  it('replaces an existing value rather than appending to it', async () => {
    await surface.fill(SEARCH_FIELD, 'First');
    await surface.fill(SEARCH_FIELD, 'Second');

    expect((await surface.extract(SEARCH_FIELD, { kind: 'value' })).value).toBe('Second');
  });

  it('fails clearly when the control cannot accept input', async () => {
    const failure = await surface.fill(RESULT_TEXT, 'Widgets').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActionFailedError);
    expect(failure).toMatchObject({ code: 'SURFACE_ACTION_FAILED' });
    expect(String(failure)).toContain('Result Text');
  });

  it('never writes the value it typed into the log', async () => {
    const sink = recordingLogger();
    const fixture = await openSurface(sink.logger);
    try {
      await fixture.surface.navigate(FIXTURE_URL);
      await fixture.surface.fill(SEARCH_FIELD, 'hunter2-should-never-be-logged');
    } finally {
      await fixture.session.close();
    }

    expect(JSON.stringify(sink.records())).not.toContain('hunter2-should-never-be-logged');
    expect(sink.records()).toContainEqual(
      expect.objectContaining({ message: 'action completed', action: 'fill' }),
    );
  });
});

describe('click', () => {
  it('activates a control and the surface reflects the change', async () => {
    await surface.fill(SEARCH_FIELD, 'Widgets');

    const result = await surface.click(SEARCH_BUTTON);

    expect(result.action).toBe('click');
    expect(result.resolvedBy).toBe('role');
    expect((await surface.extract(RESULT_TEXT)).value).toBe('Result For Widgets');
  });

  it('fails on a disabled control instead of reporting a click that never landed', async () => {
    const failure = await surface.click(DISABLED_BUTTON).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActionFailedError);
    expect(String(failure)).toContain('Reset Button');
  });

  it('reports a missing target rather than clicking something else', async () => {
    await expect(surface.click(MISSING)).rejects.toBeInstanceOf(TargetNotFoundError);
  });

  it('waits for a control that appears late instead of sleeping', async () => {
    // Exact text: the button that reveals the message also contains those words.
    const lateMessage = createTarget('Late Message', [
      { kind: 'text', text: 'Late Message', exact: true },
    ]);
    await surface.click(createTarget('Late Button', [{ kind: 'css', selector: '#late-button' }]));

    expect((await surface.extract(lateMessage)).value).toBe('Late Message');
  });
});

describe('extract', () => {
  it('reads visible text by default', async () => {
    const result = await surface.extract(RESULT_TEXT);

    expect(result.kind).toBe('text');
    expect(result.value).toBe('No Search Yet');
    expect(result.resolvedBy).toBe('attribute');
  });

  it('reads a form control value', async () => {
    await surface.fill(SEARCH_FIELD, 'Widgets');

    const result = await surface.extract(SEARCH_FIELD, { kind: 'value' });

    expect(result).toMatchObject({ kind: 'value', value: 'Widgets' });
  });

  it('reads an attribute', async () => {
    const result = await surface.extract(RESULT_TEXT, {
      kind: 'attribute',
      attribute: 'data-state',
    });

    expect(result).toMatchObject({ kind: 'attribute', value: 'empty' });
  });

  it('fails when the requested attribute is absent', async () => {
    const failure = await surface
      .extract(RESULT_TEXT, { kind: 'attribute', attribute: 'data-missing' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtractionFailedError);
    expect(String(failure)).toContain('data-missing');
  });

  it('fails when an attribute extraction names no attribute', async () => {
    await expect(surface.extract(RESULT_TEXT, { kind: 'attribute' })).rejects.toBeInstanceOf(
      ExtractionFailedError,
    );
  });

  it('fails when a value is requested from something that has none', async () => {
    await expect(surface.extract(RESULT_TEXT, { kind: 'value' })).rejects.toBeInstanceOf(
      ExtractionFailedError,
    );
  });
});

describe('screenshot', () => {
  it('returns png bytes with enough context for evidence capture', async () => {
    const result = await surface.screenshot();

    expect(result.format).toBe('png');
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.data.byteLength).toBe(result.byteLength);
    expect(result.url).toBe(FIXTURE_URL);
    expect(Date.parse(result.capturedAt)).not.toBeNaN();
  });
});

describe('an unavailable surface', () => {
  it('reports a closed session as a surface failure', async () => {
    const fixture = await openSurface();
    await fixture.surface.navigate(FIXTURE_URL);
    await fixture.session.close();

    await expect(fixture.surface.observe()).rejects.toBeInstanceOf(SurfaceUnavailableError);
    await expect(fixture.surface.navigate(FIXTURE_URL)).rejects.toBeInstanceOf(
      SurfaceUnavailableError,
    );
  });
});
