import type { Page } from 'playwright';

import { startStopwatch } from '../timing.js';
import type { Observation, ObservedControl } from '../types.js';

/**
 * Builds the bounded snapshot returned by `PlaywrightSurface.observe`.
 *
 * The snapshot is written to evidence on every step, so it is capped in both
 * directions: a serialized DOM would be unreadable, expensive to store, and would
 * capture values a user typed. Control names come from Playwright's accessibility
 * snapshot, which computes the same accessible name a screen reader would announce, so
 * an observation stays meaningful on markup that carries no test identifiers.
 */

/** Roughly a screenful of prose. Enough to tell two states apart, small enough to read. */
const MAX_SUMMARY_CHARS = 2_000;

/** Beyond this a page is a list view, and enumerating every row helps nobody. */
const MAX_CONTROLS = 40;

/**
 * One accessibility snapshot entry, for example `- button "Search" [disabled]`.
 * Entries without a quoted accessible name (plain text nodes) carry nothing a workflow
 * can target and are skipped.
 */
const CONTROL_PATTERN = /^\s*-\s+([a-z]+)\s+"((?:[^"\\]|\\.)*)"(.*)$/;

function collapseText(text: string): string {
  const lines = text.split('\n');
  const cleaned: string[] = [];
  for (const line of lines) {
    const normalized = line.replace(/\s+/g, ' ').trim();
    if (normalized.length > 0) {
      cleaned.push(normalized);
    }
  }
  return cleaned.join('\n');
}

function parseControls(snapshot: string): { controls: ObservedControl[]; truncated: boolean } {
  const controls: ObservedControl[] = [];
  let truncated = false;

  for (const line of snapshot.split('\n')) {
    const match = CONTROL_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const [, role, name = '', trailing = ''] = match;
    if (role === undefined) {
      continue;
    }
    if (controls.length >= MAX_CONTROLS) {
      truncated = true;
      break;
    }
    controls.push({
      role,
      name: name.replace(/\\(.)/g, '$1'),
      enabled: !trailing.includes('[disabled]'),
    });
  }

  return { controls, truncated };
}

export async function observePage(page: Page, timeoutMs: number): Promise<Observation> {
  const elapsed = startStopwatch();
  const body = page.locator('body');

  const [title, rawText, snapshot] = await Promise.all([
    page.title(),
    body.innerText({ timeout: timeoutMs }),
    body.ariaSnapshot({ timeout: timeoutMs }),
  ]);

  const summary = collapseText(rawText);
  const { controls, truncated } = parseControls(snapshot);

  return {
    url: page.url(),
    title,
    capturedAt: new Date().toISOString(),
    textSummary: summary.slice(0, MAX_SUMMARY_CHARS),
    truncated: truncated || summary.length > MAX_SUMMARY_CHARS,
    controls,
    durationMs: elapsed(),
  };
}
