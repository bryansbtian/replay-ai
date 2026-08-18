import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLogger, type Logger } from '../../../src/logging/logger.js';
import type { ComputerSurface, SurfaceTimeouts } from '../../../src/surfaces/index.js';
import {
  launchPlaywrightSession,
  PlaywrightSurface,
  type PlaywrightSession,
} from '../../../src/surfaces/playwright/index.js';

/**
 * Fixture plumbing shared by the surface suites: a local page, a browser session, and a
 * logger that records instead of writing. The page is a file on disk rather than a
 * hosted site so the suites stay deterministic and offline.
 */

export const FIXTURE_URL = pathToFileURL(resolve('tests/fixtures/surface.html')).href;

/** Short budgets: the fixture is local, so a failure should surface in about a second. */
export const TEST_TIMEOUTS: SurfaceTimeouts = {
  navigationMs: 10_000,
  locatorMs: 1_000,
  actionMs: 2_000,
};

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

export function silentLogger(): Logger {
  return createLogger({
    level: 'error',
    write: (_line: string): void => {
      // Suite output stays readable; assertions on log records use recordingLogger.
    },
  });
}

export interface SurfaceFixture {
  readonly surface: ComputerSurface;
  readonly session: PlaywrightSession;
}

/**
 * Opens a browser session and wraps it in a surface. This is the only place the suites
 * choose an implementation; the tests themselves work through `ComputerSurface`.
 */
export async function openSurface(logger: Logger = silentLogger()): Promise<SurfaceFixture> {
  const session = await launchPlaywrightSession();
  const surface = new PlaywrightSurface({ page: session.page, logger, timeouts: TEST_TIMEOUTS });
  return { surface, session };
}
