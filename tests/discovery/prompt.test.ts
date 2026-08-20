import { describe, expect, it } from 'vitest';

import { buildInstruction, DISCOVERY_SYSTEM_PROMPT } from '../../src/discovery/prompt.js';
import type { Observation } from '../../src/surfaces/index.js';

/**
 * The instructions the model is given, especially the ones that decide whether a run
 * completes or waits forever on a page that already shows the goal.
 */

const OBSERVATION: Observation = {
  url: 'https://www.seatping.biz/search/Japanese',
  title: 'Search Restaurants | SeatPing',
  capturedAt: '2026-08-19T20:34:25.000Z',
  textSummary: '1 result for "Japanese"\nThe Japanese Restaurant\nBook Table\nJoin Queue',
  truncated: false,
  controls: [{ role: 'button', name: 'Search', enabled: true }],
  values: [],
  durationMs: 12,
};

describe('discovery instructions', () => {
  it('tells the model to complete a search listing rather than open, book, or queue', () => {
    expect(DISCOVERY_SYSTEM_PROMPT).toContain('answer with complete');
    expect(DISCOVERY_SYSTEM_PROMPT).toContain('Do not open a result, book, join a queue');
  });

  it('tells the model to complete when the screen did not change and the listing is already visible', () => {
    const instruction = buildInstruction({
      goal: 'Search SeatPing for Japanese restaurants and reach the restaurant search results.',
      applicationName: 'SeatPing',
      entryPoint: 'https://seatping.biz',
      step: 4,
      maxSteps: 15,
      observation: OBSERVATION,
      history: [
        { step: 3, summary: 'Wait for the restaurant details to load', outcome: 'succeeded' },
      ],
      discovered: [],
      inputs: [{ name: 'cuisine', value: 'Japanese' }],
      stateUnchanged: true,
    });

    expect(instruction).toContain('answer with complete now');
    expect(instruction).toContain('Do not wait for the same text again');
    expect(instruction).toContain('1 result for "Japanese"');
  });
});
