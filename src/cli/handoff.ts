import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config/index.js';
import type { EvidenceRecorder } from '../evidence/index.js';
import type { InterventionSource } from '../execution/index.js';
import { AutomationSession, HandoffCoordinator, SessionRegistry } from '../handoff/index.js';
import type { Logger } from '../logging/logger.js';
import { startOperatorServer, type RunningOperatorServer } from '../operator/index.js';
import type { ComputerSurface } from '../surfaces/index.js';

/**
 * Turning on human handoff for one command.
 *
 * A composition root, and the only place that knows all four pieces exist: the session, the
 * coordinator that pauses on it, the registry the operator server looks things up in, and
 * the server itself. The engines are handed one interface with two methods and never learn
 * about any of this.
 */

export interface HandoffSetup {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly evidence: EvidenceRecorder;
  readonly surface: ComputerSurface;
  /** The run id, so the session, the evidence directory, and the page all agree. */
  readonly runId: string;
  readonly automation: InterventionSource;
  /** The capability name or the goal, shown to whoever answers. */
  readonly subject: string;
}

export interface HandoffContext {
  readonly coordinator: HandoffCoordinator;
  readonly operatorUrl: string;
  /** Records how the run ended, when it ended without a person ending it. */
  finish(status: string): void;
  stop(): Promise<void>;
}

export interface HandoffOutput {
  readonly stderr: (text: string) => void;
}

export async function startHandoff(
  setup: HandoffSetup,
  output: HandoffOutput,
): Promise<HandoffContext> {
  const registry = new SessionRegistry();
  const session = new AutomationSession({
    id: randomUUID(),
    runId: setup.runId,
    automation: setup.automation,
    subject: setup.subject,
  });
  const coordinator = new HandoffCoordinator({
    session,
    surface: setup.surface,
    evidence: setup.evidence,
    logger: setup.logger,
    timeoutMs: setup.config.handoff.interventionTimeoutMs,
  });
  registry.register(coordinator);

  const server: RunningOperatorServer = await startOperatorServer({
    registry,
    logger: setup.logger,
    port: setup.config.handoff.operatorPort,
    evidenceDir: setup.config.evidenceDir,
  });

  const operatorUrl = server.operatorUrlFor(session.id);

  // Printed before anything can pause, so the address is already on screen when a run
  // stops. Somebody watching a paused terminal should not have to go looking for it.
  output.stderr(
    [
      '',
      'Human Handoff Enabled',
      '',
      `  Session ID:   ${session.id}`,
      `  Operator URL: ${operatorUrl}`,
      '',
    ].join('\n'),
  );

  return {
    coordinator,
    operatorUrl,
    finish(status: string): void {
      if (session.isTerminal) {
        return;
      }
      if (status === 'success' || status === 'businessOutcome') {
        session.finish('completed');
        return;
      }
      session.finish('failed');
    },
    async stop(): Promise<void> {
      registry.release(session.id);
      await server.close();
    },
  };
}
