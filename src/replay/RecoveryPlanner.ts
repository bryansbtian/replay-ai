import type { CapabilityStep, RecoveryDefinition, RiskLevel } from '../artifacts/index.js';
import type { Logger } from '../logging/logger.js';
import type { ComputerSurface } from '../surfaces/index.js';

import type { CheckpointEvaluator } from './CheckpointEvaluator.js';
import { classifyThrown } from './classification.js';
import { withDeadline } from './deadlines.js';

/**
 * Recognizes a declared runtime condition and performs the one interaction that clears
 * it.
 *
 * This is what separates a recoverable condition from a retry. A retry says "try that
 * again"; a recovery says "we recognize the state the application is in, and we know the
 * single control that clears it". The difference is knowledge, and the knowledge lives in
 * the artifact, never here: this module matches declared conditions and activates
 * declared targets, so a dialog nobody wrote down is never touched.
 *
 * Everything about it is bounded and deterministic. Conditions are checked in stored
 * order, the first match wins, the declared attempt ceiling applies, and no model is
 * consulted at any point.
 */

/** A recognized condition, ready to be acted on. */
export interface RecognizedCondition {
  readonly definition: RecoveryDefinition;
  readonly observed: string;
}

export interface RecoveryPlannerOptions {
  readonly surface: ComputerSurface;
  readonly logger: Logger;
  readonly checkpoints: CheckpointEvaluator;
  /** Budget for recognizing a condition on a page that has already settled. */
  readonly probeBudgetMs: number;
  /** Budget for the interaction that clears it, which is a real action. */
  readonly actionBudgetMs: number;
}

/**
 * Whether retrying this step after a recovery is safe.
 *
 * Recovery ends by repeating the step that failed, so it inherits the retry rule
 * exactly. Reading and asserting cannot change the application. An acting step repeats
 * only when the artifact calls it `safe`, because clearing a dialog and then submitting
 * a request that may already have landed is how one transfer becomes two. Phase 6 will
 * decide this from policy rather than from the artifact's own description of itself.
 */
export function isRetrySafe(step: CapabilityStep): boolean {
  return riskOf(step) === undefined || riskOf(step) === 'safe';
}

/**
 * The artifact's risk declaration, for the steps that carry one. Reading and asserting
 * have no `risk` field because neither can change the application.
 *
 * Reported in the log line that suppresses a repeat, because the level is the reason.
 */
export function riskOf(step: CapabilityStep): RiskLevel | undefined {
  if (step.type === 'extract' || step.type === 'wait' || step.type === 'checkpoint') {
    return undefined;
  }
  return step.risk;
}

export class RecoveryPlanner {
  private readonly surface: ComputerSurface;
  private readonly logger: Logger;
  private readonly checkpoints: CheckpointEvaluator;
  private readonly probeBudgetMs: number;
  private readonly actionBudgetMs: number;
  /** Attempts already spent per declared code, so a ceiling holds across one run. */
  private readonly spent = new Map<string, number>();

  constructor(options: RecoveryPlannerOptions) {
    this.surface = options.surface;
    this.logger = options.logger;
    this.checkpoints = options.checkpoints;
    this.probeBudgetMs = options.probeBudgetMs;
    this.actionBudgetMs = options.actionBudgetMs;
  }

  /**
   * The first declared condition that currently holds and still has attempts left.
   *
   * Conditions are only evaluated when a step has already failed, so this costs nothing
   * on a healthy run. A capability that declares none skips the surface entirely.
   */
  async recognize(
    recoveries: readonly RecoveryDefinition[],
  ): Promise<RecognizedCondition | undefined> {
    for (const definition of recoveries) {
      if (this.exhausted(definition)) {
        continue;
      }
      const outcome = await this.evaluate(definition);
      if (outcome === undefined) {
        continue;
      }
      return { definition, observed: outcome };
    }
    return undefined;
  }

  /** True when this condition has already used every attempt the artifact allowed. */
  exhausted(definition: RecoveryDefinition): boolean {
    return (this.spent.get(definition.code) ?? 0) >= definition.maxAttempts;
  }

  /** How many attempts this condition has consumed so far in this run. */
  attemptsSpent(definition: RecoveryDefinition): number {
    return this.spent.get(definition.code) ?? 0;
  }

  /**
   * Performs the declared interaction and records the attempt against the ceiling.
   *
   * A failure to clear the state is not itself reported as the run's failure: the step
   * is retried regardless, and if it fails again the caller reports the step's own
   * failure or exhaustion. Surfacing "the Continue button could not be clicked" instead
   * of "the summary never appeared" would replace the useful failure with a symptom.
   */
  async apply(definition: RecoveryDefinition, stepId: string): Promise<boolean> {
    const attempt = this.attemptsSpent(definition) + 1;
    this.spent.set(definition.code, attempt);

    this.logger.info('Recovery Attempt Started', {
      code: definition.code,
      stepId,
      attempt,
      maxAttempts: definition.maxAttempts,
      action: definition.action.type,
      target: definition.action.target.description,
    });

    try {
      await withDeadline(
        () => this.surface.click(definition.action.target, { timeoutMs: this.actionBudgetMs }),
        this.actionBudgetMs,
      );
      return true;
    } catch (error) {
      const classified = classifyThrown(error);
      this.logger.warn('Recovery Action Failed', {
        code: definition.code,
        stepId,
        attempt,
        failureCode: classified.code,
        cause: classified.cause,
      });
      return false;
    }
  }

  private async evaluate(definition: RecoveryDefinition): Promise<string | undefined> {
    try {
      const outcome = await this.checkpoints.evaluate(definition.condition, this.probeBudgetMs);
      if (!outcome.passed) {
        return undefined;
      }
      return outcome.expected;
    } catch {
      // Recognition runs after something already went wrong. A surface that is failing
      // must not turn one reportable failure into a different, less useful one.
      return undefined;
    }
  }
}
