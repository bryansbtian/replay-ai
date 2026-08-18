import { randomUUID } from 'node:crypto';

import type { BusinessOutcomeDefinition, CapabilityArtifact } from '../artifacts/index.js';
import type { Logger } from '../logging/logger.js';
import {
  DEFAULT_SURFACE_TIMEOUTS,
  type ComputerSurface,
  type SurfaceTimeouts,
} from '../surfaces/index.js';

import { CheckpointEvaluator, type CheckpointOutcome } from './CheckpointEvaluator.js';
import { stepBudgetMs } from './deadlines.js';
import { InvocationInputError } from './errors.js';
import { validateInvocationInputs, type InvocationInputs } from './InputValidator.js';
import { OutputCollector } from './OutputCollector.js';
import type {
  ReplayBusinessOutcome,
  ReplayFailure,
  ReplayFailureCode,
  ReplayResult,
  ReplayStepRecord,
  ReplaySuccess,
} from './ReplayResult.js';
import { StepExecutor, type StepFailure } from './StepExecutor.js';

/**
 * Executes a saved capability artifact against a surface, with nothing deciding
 * anything at run time.
 *
 * The execution plan is `artifact.steps`, in stored order. The engine does not reorder
 * it, does not skip a step, does not substitute a target, does not invent a step that
 * is missing, and does not modify the artifact. There is no model here, and there is no
 * import path from this package to one: given the same artifact and the same inputs,
 * two runs issue the same operations in the same order.
 *
 * The run is a fixed sequence:
 *
 * ```text
 * validate inputs -> execute steps in order -> verify the success condition
 *   -> collect declared outputs -> return a structured result
 * ```
 *
 * The success condition is not optional and not advisory. A workflow whose every action
 * returned without throwing has proved that its controls were operable, which is not
 * the same as having reached the state it was recorded to reach.
 */

export interface ReplayEngineOptions {
  readonly surface: ComputerSurface;
  readonly logger: Logger;
  /** Waiting budgets, normally `AppConfig.surfaceTimeouts`. */
  readonly timeouts?: SurfaceTimeouts;
  /** Applies to every step that declares no budget of its own. */
  readonly stepTimeoutMs?: number;
  /** Injected in tests so a result is comparable; a run generates one otherwise. */
  readonly replayId?: string;
}

interface RunContext {
  readonly replayId: string;
  readonly artifact: CapabilityArtifact;
  readonly logger: Logger;
  readonly started: number;
  readonly completedSteps: ReplayStepRecord[];
}

/**
 * What a failure knows, before the absent parts are dropped. The engine works with
 * `undefined` internally and `withoutAbsentKeys` produces the result, which under
 * `exactOptionalPropertyTypes` may not carry an explicitly undefined property.
 */
interface FailureDetail {
  readonly code: ReplayFailureCode;
  readonly message: string;
  readonly stepId?: string | undefined;
  readonly stepType?: ReplayFailure['stepType'];
  readonly expected?: string | undefined;
  readonly observed?: string | undefined;
  readonly attempts?: number | undefined;
  readonly cause?: string | undefined;
}

type WithoutUndefined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

/** Mirrors the artifact package's helper, and exists for the same reason. */
function withoutAbsentKeys<T extends object>(value: T): WithoutUndefined<T> {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested === undefined) {
      continue;
    }
    result[key] = nested;
  }
  return result as WithoutUndefined<T>;
}

export class ReplayEngine {
  private readonly surface: ComputerSurface;
  private readonly logger: Logger;
  private readonly timeouts: SurfaceTimeouts;
  private readonly stepTimeoutMs: number | undefined;
  private readonly replayId: string | undefined;

  constructor(options: ReplayEngineOptions) {
    this.surface = options.surface;
    this.logger = options.logger;
    this.timeouts = options.timeouts ?? DEFAULT_SURFACE_TIMEOUTS;
    this.stepTimeoutMs = options.stepTimeoutMs;
    this.replayId = options.replayId;
  }

  /**
   * Replays one capability.
   *
   * Always returns a result. A bad invocation, a step that failed, a condition that did
   * not hold, and an outcome the business already knows about are all things the run
   * has to describe, so none of them is thrown at the caller.
   */
  async run(artifact: CapabilityArtifact, inputs: InvocationInputs): Promise<ReplayResult> {
    const replayId = this.replayId ?? randomUUID();
    const logger = this.logger.child({
      replayId,
      capabilityId: artifact.id,
      capabilityVersion: artifact.version,
    });
    const context: RunContext = {
      replayId,
      artifact,
      logger,
      started: performance.now(),
      completedSteps: [],
    };

    // Input names only. A value can be a credential, and an input can be declared
    // sensitive, so nothing in this record can carry one.
    logger.info('Replay Started', {
      capabilityName: artifact.name,
      stepCount: artifact.steps.length,
      inputNames: artifact.inputs.map((input) => input.name),
    });

    try {
      return await this.execute(context, inputs);
    } catch (error) {
      if (error instanceof InvocationInputError) {
        return this.fail(context, {
          code: 'REPLAY_INPUTS_INVALID',
          message: error.message,
        });
      }
      return this.fail(context, {
        code: 'REPLAY_UNEXPECTED',
        message: 'Replay stopped on an unexpected failure',
        cause: describeCause(error),
      });
    }
  }

  private async execute(context: RunContext, invocation: InvocationInputs): Promise<ReplayResult> {
    const { artifact, logger } = context;

    // Before any surface action: a caller that got the invocation wrong must not leave a
    // half-run workflow behind in the application.
    const inputs = validateInvocationInputs(artifact, invocation);

    const outputs = new OutputCollector(artifact.outputs);
    const checkpoints = new CheckpointEvaluator({ surface: this.surface });
    const executor = new StepExecutor({
      surface: this.surface,
      logger,
      checkpoints,
      inputs,
      outputs,
    });

    for (const step of artifact.steps) {
      const budgetMs = stepBudgetMs(
        step,
        withoutAbsentKeys({ timeouts: this.timeouts, stepTimeoutMs: this.stepTimeoutMs }),
      );
      logger.info('Step Started', { stepId: step.id, stepType: step.type, budgetMs });

      const outcome = await executor.execute(step, budgetMs);
      if (!outcome.ok) {
        return await this.stepFailed(
          context,
          step.id,
          step.type,
          outcome.attempts,
          outcome.failure,
        );
      }

      context.completedSteps.push({
        stepId: step.id,
        stepType: step.type,
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
      });
      logger.info('Step Completed', {
        stepId: step.id,
        stepType: step.type,
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
      });
    }

    return await this.verify(context, checkpoints, outputs);
  }

  /** The final gate: every action worked, so did the workflow actually get there? */
  private async verify(
    context: RunContext,
    checkpoints: CheckpointEvaluator,
    outputs: OutputCollector,
  ): Promise<ReplayResult> {
    const { artifact, logger } = context;
    const budgetMs = this.stepTimeoutMs ?? this.timeouts.locatorMs;
    const outcome = await checkpoints.evaluate(artifact.successCondition, budgetMs);

    if (!outcome.passed) {
      logger.warn('Success Condition Failed', describeOutcome(outcome));
      const business = await this.detectBusinessOutcome(context);
      if (business !== undefined) {
        return business;
      }
      return this.fail(context, {
        code: 'REPLAY_SUCCESS_CONDITION_FAILED',
        message: 'Every step ran, but the capability did not reach its success state',
        expected: outcome.expected,
        observed: outcome.observed,
      });
    }
    logger.info('Success Condition Passed', describeOutcome(outcome));

    const collected = outputs.collect();
    if (!collected.ok) {
      return this.fail(context, {
        code: collected.problem.code,
        message: collected.problem.message,
        expected: collected.problem.expected,
        observed: collected.problem.observed,
      });
    }

    const result: ReplaySuccess = {
      status: 'success',
      replayId: context.replayId,
      capabilityId: artifact.id,
      capabilityVersion: artifact.version,
      outputs: collected.outputs,
      completedSteps: context.completedSteps,
      durationMs: this.elapsed(context),
    };
    logger.info('Replay Completed', {
      status: result.status,
      outputNames: Object.keys(result.outputs),
      completedSteps: result.completedSteps.length,
      durationMs: result.durationMs,
    });
    return result;
  }

  /**
   * A failed step is where a known business answer can be hiding: "no member matches
   * that reference" makes the wait for a result time out, and reporting that as a
   * broken automation would send a person to look at a workflow that is working.
   *
   * Only a condition that did not hold is treated this way. A control that could not be
   * found or operated is an automation problem whatever the screen says.
   */
  private async stepFailed(
    context: RunContext,
    stepId: string,
    stepType: ReplayFailure['stepType'],
    attempts: number,
    failure: StepFailure,
  ): Promise<ReplayResult> {
    context.logger.error('Step Failed', {
      stepId,
      stepType,
      attempts,
      code: failure.code,
      expected: failure.expected,
      observed: failure.observed,
    });

    if (failure.conditionFailed) {
      const business = await this.detectBusinessOutcome(context, stepId);
      if (business !== undefined) {
        return business;
      }
    }

    return this.fail(context, {
      code: failure.code,
      message: failure.message,
      stepId,
      stepType,
      attempts,
      expected: failure.expected,
      observed: failure.observed,
      cause: failure.cause,
    });
  }

  private async detectBusinessOutcome(
    context: RunContext,
    stepId?: string,
  ): Promise<ReplayBusinessOutcome | undefined> {
    const { artifact, logger } = context;
    if (artifact.businessOutcomes.length === 0) {
      return undefined;
    }

    const checkpoints = new CheckpointEvaluator({ surface: this.surface });
    for (const outcome of artifact.businessOutcomes) {
      const observed = await this.matches(checkpoints, outcome);
      if (!observed) {
        continue;
      }

      logger.info('Business Outcome Detected', { code: outcome.code, stepId });
      const result: ReplayBusinessOutcome = withoutAbsentKeys({
        status: 'businessOutcome' as const,
        replayId: context.replayId,
        capabilityId: artifact.id,
        capabilityVersion: artifact.version,
        code: outcome.code,
        description: outcome.description,
        completedSteps: context.completedSteps,
        durationMs: this.elapsed(context),
        stepId,
      });
      return result;
    }
    return undefined;
  }

  /**
   * Detection runs after something already went wrong, so a surface that is failing
   * must not turn one reportable failure into a different, less useful one.
   */
  private async matches(
    checkpoints: CheckpointEvaluator,
    outcome: BusinessOutcomeDefinition,
  ): Promise<boolean> {
    try {
      const evaluated = await checkpoints.evaluate(outcome.condition, this.timeouts.locatorMs);
      return evaluated.passed;
    } catch {
      return false;
    }
  }

  private fail(context: RunContext, detail: FailureDetail): ReplayFailure {
    const result: ReplayFailure = withoutAbsentKeys({
      status: 'failure' as const,
      replayId: context.replayId,
      capabilityId: context.artifact.id,
      capabilityVersion: context.artifact.version,
      completedSteps: context.completedSteps,
      durationMs: this.elapsed(context),
      code: detail.code,
      message: detail.message,
      stepId: detail.stepId,
      stepType: detail.stepType,
      expected: detail.expected,
      observed: detail.observed,
      attempts: detail.attempts,
      cause: detail.cause,
    });
    context.logger.error('Replay Completed', {
      status: result.status,
      code: result.code,
      stepId: result.stepId,
      completedSteps: result.completedSteps.length,
      durationMs: result.durationMs,
    });
    return result;
  }

  private elapsed(context: RunContext): number {
    return Math.round(performance.now() - context.started);
  }
}

function describeOutcome(outcome: CheckpointOutcome): Record<string, unknown> {
  return {
    checkpointType: outcome.type,
    expected: outcome.expected,
    observed: outcome.observed,
    durationMs: outcome.durationMs,
  };
}

function describeCause(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message.split('\n')[0] ?? ''}`;
  }
  return 'unknown failure';
}
