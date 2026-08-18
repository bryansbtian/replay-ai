import type { CapabilityStep } from '../artifacts/index.js';
import type { EvidenceRecorder, RunEventName } from '../evidence/index.js';
import type { Logger, LogFields } from '../logging/logger.js';
import type { PolicyDecision } from '../policy/index.js';
import { sanitizeUrl } from '../redaction.js';
import type { ComputerSurface } from '../surfaces/index.js';

import type { CheckpointOutcome } from './CheckpointEvaluator.js';

/**
 * One call site per thing that happens, two sinks.
 *
 * A run produces a developer log and a durable evidence record, and the two must never
 * disagree about what may be written down. Keeping them behind one object is what makes
 * that structural rather than a convention: there is nowhere to log a value without also
 * deciding whether it belongs in evidence, and nothing reaches evidence that was not
 * named as an event here.
 *
 * It is not a log-to-file bridge. The log carries a Title Case message for a person
 * watching; evidence carries a snake_case event with a fixed field set for a person
 * reading months later. The same moment, written for two different readers.
 */

/** Fields that may appear in either sink. Never a resolved value or an input. */
type JournalFields = Record<string, unknown>;

export interface RunJournalOptions {
  readonly logger: Logger;
  readonly evidence: EvidenceRecorder;
}

export class RunJournal {
  private readonly logger: Logger;
  private readonly evidence: EvidenceRecorder;

  constructor(options: RunJournalOptions) {
    this.logger = options.logger;
    this.evidence = options.evidence;
  }

  /**
   * The run's own boundaries are logged here and recorded by the recorder, which brackets
   * the run because it is what creates and finalizes the manifest. Emitting them from
   * both places would put every run's first and last event in the file twice.
   */
  runStarted(fields: JournalFields): void {
    this.logger.info('Replay Started', fields);
  }

  runCompleted(fields: JournalFields): void {
    this.logger.info('Replay Completed', fields);
  }

  async stepStarted(step: CapabilityStep, budgetMs: number): Promise<void> {
    const fields = { stepId: step.id, stepType: step.type, budgetMs };
    this.logger.info('Step Started', fields);
    await this.evidence.recordEvent({ event: 'step_started', fields });
  }

  async stepCompleted(step: CapabilityStep, attempts: number, durationMs: number): Promise<void> {
    const fields = { stepId: step.id, stepType: step.type, attempts, durationMs };
    this.logger.info('Step Completed', fields);
    await this.evidence.recordEvent({ event: 'step_completed', fields });
  }

  async stepFailed(step: CapabilityStep, fields: JournalFields): Promise<void> {
    const record = { stepId: step.id, stepType: step.type, ...fields };
    this.logger.warn('Step Failed', record);
    await this.evidence.recordEvent({ event: 'step_failed', fields: record });
  }

  /**
   * Records what policy was asked and what it answered.
   *
   * Every decision is recorded, not only the denials. "Was this allowed?" is one of the
   * questions evidence exists to answer, and a record that only lists refusals cannot
   * distinguish an action that was permitted from one nobody checked.
   */
  async policyEvaluated(step: CapabilityStep, decision: PolicyDecision): Promise<void> {
    const base = { stepId: step.id, actionType: step.type, outcome: decision.outcome };
    if (decision.outcome === 'allow') {
      this.logger.debug('Policy Allowed', base);
      await this.evidence.recordEvent({ event: 'policy_evaluated', fields: base });
      return;
    }

    const denial = {
      ...base,
      code: decision.code,
      reason: decision.reason,
      detail: decision.detail,
    };
    this.logger.warn('Policy Blocked', denial);
    await this.evidence.recordEvent({ event: 'policy_evaluated', fields: base });
    await this.evidence.recordEvent({ event: 'policy_blocked', fields: denial });
  }

  /**
   * Records a state assertion.
   *
   * What the surface showed is kept only when the assertion failed. On a pass it adds
   * nothing an operator needs and everything a page happened to be displaying, and the
   * displayed content is the one part of a run that can be somebody's personal data.
   * On a failure it is the whole diagnosis, so it is kept, bounded to the short excerpt
   * the surface produces.
   */
  async checkpoint(stepId: string, outcome: CheckpointOutcome): Promise<void> {
    const fields = {
      stepId,
      checkpointType: outcome.type,
      expected: outcome.expected,
      durationMs: outcome.durationMs,
    };
    if (outcome.passed) {
      this.logger.info('Checkpoint Passed', { ...fields, observed: outcome.observed });
      await this.evidence.recordEvent({ event: 'checkpoint_passed', fields });
      return;
    }
    const failed = { ...fields, observed: outcome.observed };
    this.logger.warn('Checkpoint Failed', failed);
    await this.evidence.recordEvent({ event: 'checkpoint_failed', fields: failed });
  }

  async businessOutcomeDetected(fields: JournalFields): Promise<void> {
    this.logger.info('Business Outcome Detected', fields);
    await this.evidence.recordEvent({ event: 'business_outcome_detected', fields });
  }

  async declaredFailureDetected(fields: JournalFields): Promise<void> {
    this.logger.error('Declared Failure State Detected', fields);
    await this.evidence.recordEvent({ event: 'business_outcome_detected', fields });
  }

  async recoveryAttempted(fields: JournalFields): Promise<void> {
    this.logger.warn('Recoverable Condition Detected', fields);
    await this.evidence.recordEvent({ event: 'recovery_attempted', fields });
  }

  async recoveryExhausted(fields: JournalFields): Promise<void> {
    this.logger.error('Recovery Exhausted', fields);
    await this.evidence.recordEvent({ event: 'recovery_exhausted', fields });
  }

  /** Plain log only. A note about the run's own progress is not a durable fact. */
  note(message: string, fields: LogFields): void {
    this.logger.warn(message, fields);
  }

  /** Plain log only, at the level a routine progress note deserves. */
  debug(message: string, fields: LogFields): void {
    this.logger.debug(message, fields);
  }

  /**
   * Captures the richer signal for the failure that ended a run.
   *
   * Wrapped whole, because a screenshot is the one piece of evidence that involves
   * driving the surface again. If the page is gone, or the disk is full, the run still
   * has a result and that result must not change; the problem is recorded as a warning
   * on the manifest instead of thrown at a caller who cannot act on it.
   */
  async captureFailure(surface: ComputerSurface, label: string): Promise<void> {
    if (!this.evidence.capturesScreenshots) {
      return;
    }
    try {
      const shot = await surface.screenshot();
      const file = await this.evidence.saveScreenshot(label, shot.data);
      if (file === undefined) {
        return;
      }
      this.logger.info('Screenshot Captured', { file, url: sanitizeUrl(shot.url) });
    } catch (error) {
      this.logger.warn('Screenshot Not Captured', {
        label,
        reason: describe(error),
      });
    }
  }

  /** Escape hatch for an event with no dedicated method yet. */
  async record(event: RunEventName, fields: JournalFields): Promise<void> {
    await this.evidence.recordEvent({ event, fields });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message.split('\n')[0] ?? ''}`;
  }
  return 'unknown failure';
}
