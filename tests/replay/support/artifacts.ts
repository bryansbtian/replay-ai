import { parseCapabilityArtifact, type CapabilityArtifact } from '../../../src/artifacts/index.js';
import { createLogger, type Logger } from '../../../src/logging/logger.js';
import type { SurfaceTimeouts } from '../../../src/surfaces/index.js';

/**
 * Artifact plumbing for the replay suites.
 *
 * Every artifact a suite replays is built as JSON and put through the real Phase 3
 * validator, so a test can never accidentally exercise the engine with a document the
 * store would have refused.
 */

export type JsonObject = Record<string, unknown>;

/** Short budgets: nothing here waits on an application, so a failure should be quick. */
export const TEST_TIMEOUTS: SurfaceTimeouts = {
  navigationMs: 500,
  locatorMs: 200,
  actionMs: 200,
};

export function silentLogger(): Logger {
  return createLogger({
    level: 'error',
    write: (): void => {
      // Suite output stays readable; assertions on records use recordingLogger.
    },
  });
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly records: () => Record<string, unknown>[];
}

export function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    write: (line: string): void => {
      lines.push(line);
    },
  });
  return {
    logger,
    records: (): Record<string, unknown>[] => {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

export function memberIdTarget(): JsonObject {
  return {
    description: 'Member ID Field',
    strategies: [{ kind: 'role', role: 'textbox', name: 'Member ID' }],
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
    description: 'Member Summary Region',
    strategies: [{ kind: 'role', role: 'region', name: 'Member Summary' }],
  };
}

export function balanceTarget(): JsonObject {
  return {
    description: 'Savings Balance Value',
    strategies: [{ kind: 'attribute', attribute: 'data-field', value: 'savings-balance' }],
  };
}

const BASE: JsonObject = {
  schemaVersion: '1',
  id: 'lookup-demo-member',
  name: 'Lookup Demo Member',
  description: 'Looks up a demo member by id and reads the savings balance.',
  version: 3,
  application: { name: 'Demo Member Console', entryPoint: 'https://demo.replay-ai.test/members' },
  successCondition: { type: 'targetVisible', target: summaryTarget() },
  metadata: { createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z' },
};

/**
 * An artifact exercising every step type replay supports, in one order, with one input
 * and one typed output.
 */
export function fullArtifact(overrides: JsonObject = {}): CapabilityArtifact {
  return artifact({
    inputs: [
      {
        name: 'memberId',
        type: 'string',
        required: true,
        description: 'Member id printed on the demo member record.',
      },
    ],
    outputs: [
      {
        name: 'savingsBalance',
        type: 'number',
        description: 'Savings balance shown on the member summary.',
      },
    ],
    steps: [
      { id: 'open-lookup', type: 'navigate', url: 'https://demo.replay-ai.test/members' },
      {
        id: 'confirm-screen',
        type: 'checkpoint',
        condition: { type: 'textVisible', text: 'Demo Member Lookup' },
      },
      {
        id: 'enter-member-id',
        type: 'fill',
        target: memberIdTarget(),
        value: { source: 'input', name: 'memberId' },
      },
      { id: 'submit-search', type: 'click', target: searchButtonTarget() },
      {
        id: 'await-summary',
        type: 'wait',
        condition: { type: 'targetVisible', target: summaryTarget() },
      },
      { id: 'read-balance', type: 'extract', target: balanceTarget(), output: 'savingsBalance' },
    ],
    ...overrides,
  });
}

/** A one-step artifact, for cases that are about the engine rather than a workflow. */
export function singleStepArtifact(
  step: JsonObject,
  overrides: JsonObject = {},
): CapabilityArtifact {
  return artifact({ inputs: [], outputs: [], steps: [step], ...overrides });
}

export function artifact(overrides: JsonObject): CapabilityArtifact {
  return parseCapabilityArtifact({ ...BASE, ...overrides });
}
