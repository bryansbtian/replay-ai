import { randomUUID } from 'node:crypto';

import type { EvidenceRecorder } from '../evidence/index.js';
import type {
  InterventionContext,
  InterventionHandler,
  InterventionOutcome,
  InterventionSettlement,
} from '../execution/index.js';
import type { Logger } from '../logging/logger.js';
import { sanitizeUrl } from '../redaction.js';
import type { ComputerSurface, HumanAction, HumanControlSurface } from '../surfaces/index.js';

import { ControlOwnershipError, type AutomationSession } from './AutomationSession.js';
import type { InterventionRequest } from './InterventionRequest.js';

/**
 * The mechanism behind a handoff: pause here, hand a person the live session, take it back.
 *
 * The pause is the interesting part and it is deliberately unremarkable. `request` returns
 * a promise that nothing resolves until an operator acts, and the engine is sitting inside
 * that await. There is no background loop, no polling, and no queue: a paused run is a
 * stack frame, so it cannot issue an action while it waits because there is no code left
 * running that could.
 *
 * Nothing here knows about Playwright, a browser, or a model. It is given a surface it
 * cannot identify and asks two questions of it: take a screenshot, and can you be operated
 * by a person. The second is a capability check rather than an assumption, because a
 * surface driving something without a screen cannot be handed over and should say so
 * instead of pretending.
 */

/** How long a request may sit unanswered. Generous: somebody has to walk to a keyboard. */
export const DEFAULT_INTERVENTION_TIMEOUT_MS = 900_000;

/** A surface that can be handed to a person, when the one in use happens to be able to. */
function humanControlOf(surface: ComputerSurface): HumanControlSurface | undefined {
  const candidate = surface as Partial<HumanControlSurface>;
  if (
    typeof candidate.beginHumanControl === 'function' &&
    typeof candidate.endHumanControl === 'function'
  ) {
    return candidate as HumanControlSurface;
  }
  return undefined;
}

export interface HandoffCoordinatorOptions {
  readonly session: AutomationSession;
  readonly surface: ComputerSurface;
  readonly evidence: EvidenceRecorder;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** Injected in tests so a request id and its timestamps are comparable. */
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The pending pause: what resolves it, and what stops it waiting forever. */
interface Pending {
  readonly resolve: (outcome: InterventionOutcome) => void;
  readonly timer: NodeJS.Timeout;
}

export class HandoffCoordinator implements InterventionHandler {
  readonly session: AutomationSession;

  private readonly surface: ComputerSurface;
  private readonly evidence: EvidenceRecorder;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private pending: Pending | undefined;

  constructor(options: HandoffCoordinatorOptions) {
    this.session = options.session;
    this.surface = options.surface;
    this.evidence = options.evidence;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_INTERVENTION_TIMEOUT_MS;
    this.now = options.now ?? ((): Date => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /**
   * Stops the run, records what is being asked for, and waits.
   *
   * The screenshot is taken before the session changes hands, so what the operator sees is
   * the state that stopped the run rather than whatever the page became afterwards.
   */
  async request(context: InterventionContext): Promise<InterventionOutcome> {
    if (this.session.isTerminal) {
      return { status: 'unavailable', reason: 'The session has already finished.' };
    }

    const url = await this.currentUrl();
    const screenshot = await this.capture(context.reason);

    const intervention: InterventionRequest = {
      id: this.newId(),
      sessionId: this.session.id,
      runId: this.session.runId,
      source: context.source,
      reason: context.reason,
      subject: context.subject,
      code: context.code,
      detail: context.detail,
      url,
      requestedAt: this.now().toISOString(),
      ...(context.stepId !== undefined && { stepId: context.stepId }),
      ...(screenshot !== undefined && { screenshot }),
    };

    this.session.requestIntervention(intervention);

    this.logger.warn('Intervention Requested', {
      handoffId: this.session.id,
      interventionId: intervention.id,
      reason: intervention.reason,
      code: intervention.code,
      stepId: intervention.stepId,
    });
    await this.evidence.recordEvent({
      event: 'intervention_requested',
      fields: {
        interventionId: intervention.id,
        handoffId: this.session.id,
        source: intervention.source,
        reason: intervention.reason,
        code: intervention.code,
        stepId: intervention.stepId,
        url: intervention.url,
        screenshot: intervention.screenshot,
      },
    });

    // Recorded as its own moment rather than folded into the request, because "a person was
    // asked" and "the automation stopped" are two claims and a reader should see both.
    await this.evidence.recordEvent({
      event: 'automation_paused',
      fields: { handoffId: this.session.id, interventionId: intervention.id },
    });

    return await this.wait();
  }

  /**
   * Records what the engine found once control came back.
   *
   * The session leaves `resuming` here and nowhere else, so a run that gave up and a run
   * that continued both leave the session in a state that matches what actually happened.
   */
  async settle(settlement: InterventionSettlement): Promise<void> {
    if (this.session.state !== 'resuming') {
      return;
    }

    if (settlement.resumed) {
      this.session.completeResume();
      this.logger.info('Automation Resumed', { handoffId: this.session.id });
      await this.evidence.recordEvent({
        event: 'automation_resumed',
        fields: { handoffId: this.session.id, controlOwner: this.session.controlOwner },
      });
      return;
    }

    this.session.finish('failed');
    this.logger.warn('Resume Failed', { handoffId: this.session.id, detail: settlement.detail });
    await this.evidence.recordEvent({
      event: 'resume_failed',
      fields: { handoffId: this.session.id, detail: settlement.detail },
    });
  }

  /**
   * Hands the live session to a person.
   *
   * The surface is the one automation was already using, so its cookies, its history, and
   * whatever is half-typed into its form are all still there. Nothing is opened.
   */
  async takeControl(): Promise<void> {
    this.session.takeControl();

    const controllable = humanControlOf(this.surface);
    if (controllable === undefined) {
      // Said plainly rather than silently skipped: the operator still owns the session and
      // can resolve the state by other means, but nothing they do will be recorded.
      this.logger.warn('Human Actions Not Recorded', {
        handoffId: this.session.id,
        reason: 'the surface in use cannot be operated by a person',
      });
    } else {
      await controllable.beginHumanControl((action) => {
        void this.onHumanAction(action);
      });
    }

    this.logger.info('Human Control Started', { handoffId: this.session.id });
    await this.evidence.recordEvent({
      event: 'human_control_started',
      fields: {
        handoffId: this.session.id,
        interventionId: this.session.intervention?.id,
        recordingActions: controllable !== undefined,
      },
    });
  }

  /**
   * Takes control back and lets the paused run continue.
   *
   * Resolving with `resolved` is not a claim that the problem is fixed. The engine checks
   * the application itself, and reports what it found through `settle`.
   */
  async resume(): Promise<void> {
    this.session.beginResume();
    await this.stopRecording();

    this.logger.info('Human Control Ended', {
      handoffId: this.session.id,
      humanActions: this.session.humanActions.length,
    });
    await this.evidence.recordEvent({
      event: 'human_control_ended',
      fields: {
        handoffId: this.session.id,
        interventionId: this.session.intervention?.id,
        humanActions: this.session.humanActions.length,
      },
    });

    this.settlePending({ status: 'resolved' });
  }

  /**
   * Ends the session on the operator's word.
   *
   * The paused run is released with `aborted` so it can finish and report, rather than
   * being left waiting on a promise nobody will resolve.
   */
  async abort(reason: string): Promise<void> {
    const wasHuman = this.session.controlOwner === 'human';
    this.session.abort();
    if (wasHuman) {
      await this.stopRecording();
    }

    this.logger.warn('Session Aborted', { handoffId: this.session.id, reason });
    await this.evidence.recordEvent({
      event: 'session_aborted',
      fields: {
        handoffId: this.session.id,
        interventionId: this.session.intervention?.id,
        reason,
        humanActions: this.session.humanActions.length,
      },
    });

    this.settlePending({ status: 'aborted', reason });
  }

  /**
   * The session id, under a name the shared redaction rules will not blank out.
   *
   * They replace any field whose name contains "session", which is right for a session
   * cookie and wrong for an identifier that is already in the operator page URL. Renaming
   * the field keeps the rule intact and the record readable.
   */

  /** Records one thing a person did. Never carries what they typed. */
  private async onHumanAction(action: HumanAction): Promise<void> {
    try {
      this.session.recordHumanAction({
        actionType: action.actionType,
        url: action.url,
        at: action.at,
        ...(action.target !== undefined && { target: action.target }),
        ...(action.role !== undefined && { role: action.role }),
      });
    } catch (error) {
      // An event arriving after control was handed back is late, not wrong. Dropping it is
      // better than letting a browser callback take down the run.
      if (error instanceof ControlOwnershipError) {
        return;
      }
      throw error;
    }

    await this.evidence.recordEvent({
      event: 'human_action',
      fields: {
        handoffId: this.session.id,
        actionType: action.actionType,
        target: action.target,
        role: action.role,
        url: action.url,
      },
    });
  }

  private async stopRecording(): Promise<void> {
    const controllable = humanControlOf(this.surface);
    await controllable?.endHumanControl();
  }

  private wait(): Promise<InterventionOutcome> {
    return new Promise<InterventionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        void this.expire();
      }, this.timeoutMs);
      // Never keeps the process alive on its own: a run waiting for a person that nobody is
      // coming for should not be the reason the command does not exit.
      timer.unref?.();
      this.pending = { resolve, timer };
    });
  }

  private async expire(): Promise<void> {
    if (this.pending === undefined || this.session.isTerminal) {
      return;
    }
    this.session.finish('failed');
    this.logger.warn('Intervention Timed Out', {
      handoffId: this.session.id,
      timeoutMs: this.timeoutMs,
    });
    await this.evidence.recordEvent({
      event: 'intervention_timeout',
      fields: { handoffId: this.session.id, timeoutMs: this.timeoutMs },
    });
    this.settlePending({
      status: 'unavailable',
      reason: `No operator took control within ${this.timeoutMs}ms.`,
    });
  }

  private settlePending(outcome: InterventionOutcome): void {
    const pending = this.pending;
    if (pending === undefined) {
      return;
    }
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }

  private async currentUrl(): Promise<string> {
    try {
      const observation = await this.surface.observe();
      return sanitizeUrl(observation.url);
    } catch {
      // A surface too broken to observe is exactly when a person is most needed, so this
      // reports what it can rather than turning the request into a second failure.
      return 'unknown';
    }
  }

  private async capture(label: string): Promise<string | undefined> {
    if (!this.evidence.capturesScreenshots) {
      return undefined;
    }
    try {
      const shot = await this.surface.screenshot();
      return await this.evidence.saveScreenshot(label, shot.data);
    } catch {
      return undefined;
    }
  }
}
