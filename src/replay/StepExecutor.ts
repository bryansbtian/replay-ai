import type { CapabilityStep } from '../artifacts/index.js';
import type { Logger } from '../logging/logger.js';
import type { ComputerSurface } from '../surfaces/index.js';

import type { CheckpointEvaluator, CheckpointOutcome } from './CheckpointEvaluator.js';
import { classifyThrown } from './classification.js';
import { withDeadline } from './deadlines.js';
import type { ResolvedInputs } from './InputValidator.js';
import type { OutputCollector } from './OutputCollector.js';
import { resolveParameter } from './ParameterResolver.js';
import { isRetrySafe, riskOf } from './RecoveryPlanner.js';
import type { EngineFailureCode } from './ReplayResult.js';

/**
 * Applies one stored step to the surface.
 *
 * The executor decides nothing about the workflow. It is handed a step, it performs the
 * one operation that step names, and it reports what happened. Ordering belongs to the
 * engine, and what to do about a failure belongs to the engine too, which is what keeps
 * this file free of anything resembling a strategy.
 *
 * Failures are returned rather than thrown, because in a replay a failed step is an
 * outcome the run has to describe, not an exception the caller has to guess at.
 */

export interface StepFailure {
  readonly code: EngineFailureCode;
  readonly message: string;
  readonly expected?: string;
  readonly observed?: string;
  /** A rendered one-line summary. Never the original surface exception. */
  readonly cause?: string;
  /**
   * True when a `wait` or `checkpoint` condition simply did not hold. That is where a
   * declared business outcome may be the real answer, so the engine needs to tell it
   * apart from a control that could not be operated.
   */
  readonly conditionFailed: boolean;
}

export type StepOutcome =
  | { readonly ok: true; readonly attempts: number; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly attempts: number;
      readonly durationMs: number;
      readonly failure: StepFailure;
    };

export interface StepExecutorOptions {
  readonly surface: ComputerSurface;
  readonly logger: Logger;
  readonly checkpoints: CheckpointEvaluator;
  readonly inputs: ResolvedInputs;
  readonly outputs: OutputCollector;
}

/**
 * How many times this step may be executed.
 *
 * A retry repeats the identical operation with the identical value and target, so the
 * only question is whether repeating it is safe, which is exactly what `isRetrySafe`
 * answers for a recovery too. Phase 3 already refuses a retry on an `irreversible` step.
 *
 * A suppressed retry is logged rather than hidden, because a declaration that does
 * nothing is worth knowing about.
 */
function maxAttempts(step: CapabilityStep, logger: Logger): number {
  const declared = step.execution?.retry?.maxAttempts;
  if (declared === undefined || declared <= 1) {
    return 1;
  }
  if (isRetrySafe(step)) {
    return declared;
  }

  logger.warn('Retry Not Applied', {
    stepId: step.id,
    stepType: step.type,
    risk: riskOf(step),
    reason: 'a step that changes the application is not repeated automatically',
  });
  return 1;
}

/**
 * Turns anything thrown during a step into a reportable failure.
 *
 * The code comes from `classification.ts`, which is the only module that knows the
 * surface error types. This function adds the part a person reads: which step, doing
 * what, and what went wrong with it.
 */
function toFailure(step: CapabilityStep, budgetMs: number, error: unknown): StepFailure {
  const classified = classifyThrown(error);

  if (classified.code === 'REPLAY_STEP_TIMEOUT') {
    return {
      code: classified.code,
      message: `Step "${step.id}" (${step.type}) did not complete within ${budgetMs}ms`,
      expected: `Completion Within ${budgetMs}ms`,
      observed: 'No Response',
      cause: classified.cause,
      conditionFailed: false,
    };
  }

  return {
    code: classified.code,
    message: `Step "${step.id}" (${step.type}) failed: ${classified.detail}`,
    cause: classified.cause,
    conditionFailed: false,
  };
}

export class StepExecutor {
  private readonly surface: ComputerSurface;
  private readonly logger: Logger;
  private readonly checkpoints: CheckpointEvaluator;
  private readonly inputs: ResolvedInputs;
  private readonly outputs: OutputCollector;

  constructor(options: StepExecutorOptions) {
    this.surface = options.surface;
    this.logger = options.logger;
    this.checkpoints = options.checkpoints;
    this.inputs = options.inputs;
    this.outputs = options.outputs;
  }

  /**
   * Runs one step, repeating it up to its bounded attempt count.
   *
   * A retry changes nothing about the attempt: same action, same target, same resolved
   * value. There is no backoff, because a fixed delay would be the clock-based waiting
   * the surface exists to avoid, and no fallback, because choosing a different action
   * would be a decision made without the artifact's authority.
   */
  async execute(step: CapabilityStep, budgetMs: number): Promise<StepOutcome> {
    const limit = maxAttempts(step, this.logger);
    let attempts = 0;
    let elapsed = 0;
    let failure: StepFailure | undefined;

    while (attempts < limit) {
      attempts += 1;
      const started = performance.now();
      failure = await this.attempt(step, budgetMs);
      elapsed += Math.round(performance.now() - started);

      if (failure === undefined) {
        return { ok: true, attempts, durationMs: elapsed };
      }
      if (attempts < limit) {
        this.logger.warn('Step Retrying', {
          stepId: step.id,
          stepType: step.type,
          attempt: attempts,
          maxAttempts: limit,
          code: failure.code,
        });
      }
    }

    // The loop always assigns `failure` before it can end here; the fallback keeps the
    // return type honest without an assertion.
    return {
      ok: false,
      attempts,
      durationMs: elapsed,
      failure: failure ?? toFailure(step, budgetMs, new Error('step did not run')),
    };
  }

  /** One attempt. Returns the failure, or `undefined` when the step succeeded. */
  private async attempt(step: CapabilityStep, budgetMs: number): Promise<StepFailure | undefined> {
    try {
      return await this.perform(step, budgetMs);
    } catch (error) {
      return toFailure(step, budgetMs, error);
    }
  }

  private async perform(step: CapabilityStep, budgetMs: number): Promise<StepFailure | undefined> {
    switch (step.type) {
      case 'navigate':
        await withDeadline(
          () => this.surface.navigate(step.url, { timeoutMs: budgetMs }),
          budgetMs,
        );
        return undefined;

      case 'click':
        await withDeadline(
          () => this.surface.click(step.target, { timeoutMs: budgetMs }),
          budgetMs,
        );
        return undefined;

      case 'fill':
        return await this.fill(step, budgetMs);

      case 'extract':
        return await this.extract(step, budgetMs);

      case 'wait':
        return await this.condition(step, budgetMs, 'REPLAY_WAIT_TIMEOUT');

      case 'checkpoint':
        return await this.condition(step, budgetMs, 'REPLAY_CHECKPOINT_FAILED');
    }
  }

  private async fill(
    step: Extract<CapabilityStep, { type: 'fill' }>,
    budgetMs: number,
  ): Promise<StepFailure | undefined> {
    const resolution = resolveParameter(step.value, this.inputs);
    if (!resolution.resolved) {
      return {
        code: 'REPLAY_PARAMETER_UNRESOLVED',
        message: `Step "${step.id}" needs input "${resolution.unresolved.inputName}", which was not supplied`,
        expected: `A Value For Input "${resolution.unresolved.inputName}"`,
        observed: 'No Value',
        conditionFailed: false,
      };
    }

    // The resolved value is never logged and never placed in a result: it is the one
    // piece of a replay that can be a password or personal data.
    await withDeadline(
      () => this.surface.fill(step.target, resolution.value, { timeoutMs: budgetMs }),
      budgetMs,
    );
    return undefined;
  }

  private async extract(
    step: Extract<CapabilityStep, { type: 'extract' }>,
    budgetMs: number,
  ): Promise<StepFailure | undefined> {
    const extraction = await withDeadline(
      () => this.surface.extract(step.target, { timeoutMs: budgetMs }),
      budgetMs,
    );

    const recorded = this.outputs.record(step.output, extraction.value);
    if (recorded.ok) {
      return undefined;
    }
    return {
      code: recorded.problem.code,
      message: recorded.problem.message,
      expected: recorded.problem.expected,
      observed: recorded.problem.observed,
      conditionFailed: false,
    };
  }

  private async condition(
    step: Extract<CapabilityStep, { type: 'wait' | 'checkpoint' }>,
    budgetMs: number,
    code: EngineFailureCode,
  ): Promise<StepFailure | undefined> {
    const outcome = await this.checkpoints.evaluate(step.condition, budgetMs);
    this.logCheckpoint(step.id, outcome);

    if (outcome.passed) {
      return undefined;
    }
    return {
      code,
      message: `Step "${step.id}" (${step.type}) expected ${outcome.expected}, but the surface showed ${outcome.observed}`,
      expected: outcome.expected,
      observed: outcome.observed,
      conditionFailed: true,
    };
  }

  private logCheckpoint(stepId: string, outcome: CheckpointOutcome): void {
    const fields = {
      stepId,
      checkpointType: outcome.type,
      expected: outcome.expected,
      observed: outcome.observed,
      durationMs: outcome.durationMs,
    };
    if (outcome.passed) {
      this.logger.info('Checkpoint Passed', fields);
      return;
    }
    this.logger.warn('Checkpoint Failed', fields);
  }
}
