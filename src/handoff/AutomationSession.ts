import { ReplayAiError } from '../errors.js';
import type { InterventionSource } from '../execution/index.js';

import type { InterventionRequest } from './InterventionRequest.js';

/**
 * Who is allowed to act on the session right now.
 *
 * One value, never a pair of booleans. `isPaused` and `hasHuman` can be set independently,
 * and half of those combinations are states nobody designed: paused with no human, running
 * with a human, both at once. A single owner makes the invalid states unrepresentable, and
 * makes "may automation act?" a comparison rather than a judgement.
 */
export const CONTROL_OWNERS = ['replay', 'discovery', 'human', 'none'] as const;

export type ControlOwner = (typeof CONTROL_OWNERS)[number];

/**
 * Where the session is in its life.
 *
 * Six, each one a genuinely different thing to do next. `waitingForHuman` and
 * `humanControl` are separate because the gap between them matters: a request that nobody
 * has picked up is not the same as a person standing at the keyboard, and only the second
 * one means the browser is being touched.
 */
export const SESSION_STATES = [
  'running',
  'waitingForHuman',
  'humanControl',
  'resuming',
  'completed',
  'failed',
  'aborted',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/** States from which nothing further can happen. Checked rather than assumed. */
const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['completed', 'failed', 'aborted']);

/**
 * Every move the session is allowed to make.
 *
 * Written out rather than inferred, because the interesting property of this table is what
 * it does not contain: there is no way from `aborted` to anything, no way from `running`
 * straight to `humanControl` without the pause in between, and no second `takeControl`
 * because `humanControl` cannot reach itself.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  running: ['waitingForHuman', 'completed', 'failed', 'aborted'],
  waitingForHuman: ['humanControl', 'failed', 'aborted'],
  humanControl: ['resuming', 'aborted'],
  resuming: ['running', 'failed', 'aborted'],
  completed: [],
  failed: [],
  aborted: [],
};

/** Raised when something asks the session to do what its current state does not allow. */
export class InvalidSessionTransitionError extends ReplayAiError {
  constructor(from: SessionState, to: SessionState) {
    super(`A session in state "${from}" cannot move to "${to}".`, 'HANDOFF_TRANSITION_INVALID');
  }
}

/** Raised when an actor tries to act on a session somebody else owns. */
export class ControlOwnershipError extends ReplayAiError {
  constructor(expected: ControlOwner, actual: ControlOwner) {
    super(
      `This action requires control of the session, which is currently held by "${actual}" rather than "${expected}".`,
      'HANDOFF_CONTROL_DENIED',
    );
  }
}

export interface AutomationSessionOptions {
  readonly id: string;
  /** The run this session belongs to, so evidence and session share one identity. */
  readonly runId: string;
  /** Which engine started it, and which one gets control back after a handoff. */
  readonly automation: InterventionSource;
  readonly subject: string;
  readonly now?: () => Date;
}

/** The session as the operator UI and the API render it. Never carries a live object. */
export interface SessionView {
  readonly id: string;
  readonly runId: string;
  readonly automation: InterventionSource;
  readonly subject: string;
  readonly state: SessionState;
  readonly controlOwner: ControlOwner;
  readonly currentStepId?: string;
  readonly intervention?: InterventionRequest;
  readonly humanActions: readonly RecordedHumanAction[];
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** A human action as the session remembers it. Already safe to display. */
export interface RecordedHumanAction {
  readonly actionType: string;
  readonly target?: string;
  readonly role?: string;
  readonly url: string;
  readonly at: string;
}

/**
 * One run's control state.
 *
 * Holds no browser object and no page. The live session is owned by whoever launched it and
 * reached through `ComputerSurface`; this tracks who is allowed to use it, which is the
 * only part of the arrangement that needs to be inspected, serialized, and rendered.
 */
export class AutomationSession {
  readonly id: string;
  readonly runId: string;
  readonly automation: InterventionSource;
  readonly subject: string;
  readonly startedAt: string;

  private readonly clock: () => Date;
  private currentState: SessionState = 'running';
  private owner: ControlOwner;
  private stepId: string | undefined;
  private request: InterventionRequest | undefined;
  private readonly actions: RecordedHumanAction[] = [];
  private updatedAt: string;

  constructor(options: AutomationSessionOptions) {
    this.id = options.id;
    this.runId = options.runId;
    this.automation = options.automation;
    this.subject = options.subject;
    this.clock = options.now ?? ((): Date => new Date());
    this.owner = options.automation;
    this.startedAt = this.clock().toISOString();
    this.updatedAt = this.startedAt;
  }

  get state(): SessionState {
    return this.currentState;
  }

  get controlOwner(): ControlOwner {
    return this.owner;
  }

  get currentStepId(): string | undefined {
    return this.stepId;
  }

  get intervention(): InterventionRequest | undefined {
    return this.request;
  }

  get humanActions(): readonly RecordedHumanAction[] {
    return this.actions;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.currentState);
  }

  /**
   * Whether automation may issue an action right now.
   *
   * Asked before every step, so a paused run cannot act by accident. It is deliberately not
   * "is the state running", because a session can be running while a person still holds it
   * in some future arrangement, and ownership is the question that actually matters.
   */
  get automationMayAct(): boolean {
    return this.currentState === 'running' && this.owner === this.automation;
  }

  /** Which step the run is on, for the operator page. */
  noteStep(stepId: string): void {
    this.stepId = stepId;
    this.touch();
  }

  /**
   * Pauses the run and records what a person is being asked for.
   *
   * Ownership goes to nobody rather than straight to the human: the request exists and the
   * automation has stopped, but until somebody takes control there is no one to hand the
   * browser to, and pretending otherwise would let a resume happen without a person.
   */
  requestIntervention(request: InterventionRequest): void {
    this.transition('waitingForHuman');
    this.request = request;
    this.owner = 'none';
    // The step the run stopped on is the one an operator needs to see, and it is the most
    // reliable thing the session knows about where the run is.
    if (request.stepId !== undefined) {
      this.stepId = request.stepId;
    }
  }

  /**
   * Hands the live session to a person.
   *
   * Rejected unless the session is waiting for one, which is what makes a second
   * `takeControl` impossible: `humanControl` cannot reach itself in the transition table.
   */
  takeControl(): void {
    this.transition('humanControl');
    this.owner = 'human';
  }

  recordHumanAction(action: RecordedHumanAction): void {
    if (this.owner !== 'human') {
      throw new ControlOwnershipError('human', this.owner);
    }
    this.actions.push(action);
    this.touch();
  }

  /**
   * Takes control back from the person.
   *
   * Moves to `resuming` rather than to `running`, because whether the run may actually
   * continue is a question about the application rather than about the session, and the
   * engine has to look before that is decided.
   */
  beginResume(): void {
    if (this.owner !== 'human') {
      throw new ControlOwnershipError('human', this.owner);
    }
    this.transition('resuming');
    this.owner = 'none';
  }

  /** The application is in the expected state; the engine gets its session back. */
  completeResume(): void {
    this.transition('running');
    this.owner = this.automation;
    this.request = undefined;
  }

  abort(): void {
    this.transition('aborted');
    this.owner = 'none';
  }

  finish(state: 'completed' | 'failed'): void {
    this.transition(state);
    this.owner = 'none';
  }

  /** What the API and the operator page render. A copy, so nothing can mutate the session. */
  view(): SessionView {
    return {
      id: this.id,
      runId: this.runId,
      automation: this.automation,
      subject: this.subject,
      state: this.currentState,
      controlOwner: this.owner,
      humanActions: [...this.actions],
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      ...(this.stepId !== undefined && { currentStepId: this.stepId }),
      ...(this.request !== undefined && { intervention: this.request }),
    };
  }

  private transition(to: SessionState): void {
    const allowed = ALLOWED_TRANSITIONS[this.currentState];
    if (!allowed.includes(to)) {
      throw new InvalidSessionTransitionError(this.currentState, to);
    }
    this.currentState = to;
    this.touch();
  }

  private touch(): void {
    this.updatedAt = this.clock().toISOString();
  }
}
