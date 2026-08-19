import { ReplayAiError } from '../errors.js';

import type { SessionView } from './AutomationSession.js';
import type { HandoffCoordinator } from './HandoffCoordinator.js';

/**
 * The sessions this process is running, by id.
 *
 * A Map, and deliberately nothing more. Sessions exist for as long as the command that
 * started them, the operator server runs inside that same process, and a handoff is one
 * person walking to one browser. A database or a shared cache would add durability that
 * nothing here can use: a session's whole value is the live browser it points at, and that
 * browser does not survive the process either.
 *
 * The cut is real and worth naming. Restarting the CLI loses any paused session, and an
 * operator on another machine cannot reach one. Both are documented rather than designed
 * around, because the alternative is remote browser infrastructure this phase does not need.
 */

export class SessionNotFoundError extends ReplayAiError {
  constructor(sessionId: string) {
    super(
      `No session with id "${sessionId}" is running in this process.`,
      'HANDOFF_SESSION_UNKNOWN',
    );
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, HandoffCoordinator>();

  register(coordinator: HandoffCoordinator): void {
    this.sessions.set(coordinator.session.id, coordinator);
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** @throws SessionNotFoundError so a stale operator page gets an answer, not a crash. */
  require(sessionId: string): HandoffCoordinator {
    const coordinator = this.sessions.get(sessionId);
    if (coordinator === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    return coordinator;
  }

  find(sessionId: string): HandoffCoordinator | undefined {
    return this.sessions.get(sessionId);
  }

  /** Every live session, for an operator page that was opened without an id. */
  list(): SessionView[] {
    return [...this.sessions.values()].map((coordinator) => coordinator.session.view());
  }
}
