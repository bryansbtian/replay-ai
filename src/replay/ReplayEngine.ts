import { randomUUID } from 'node:crypto';

import type {
  BusinessOutcomeDefinition,
  CapabilityArtifact,
  CapabilityStep,
} from '../artifacts/index.js';
import { NO_EVIDENCE, type EvidenceRecorder } from '../evidence/index.js';
import type { Logger } from '../logging/logger.js';
import type { PolicyDecision, PolicyEngine } from '../policy/index.js';
import {
  DEFAULT_SURFACE_TIMEOUTS,
  type ComputerSurface,
  type SurfaceTimeouts,
} from '../surfaces/index.js';

import { CheckpointEvaluator, type CheckpointOutcome } from './CheckpointEvaluator.js';
import { describeCause, isRecoveryEligible } from './classification.js';
import { probeBudgetMs, stepBudgetMs } from './deadlines.js';
import { InvocationInputError } from './errors.js';
import { validateInvocationInputs, type InvocationInputs } from './InputValidator.js';
import { OutputCollector } from './OutputCollector.js';
import { isPolicyDenial } from './policyGate.js';
import { isRetrySafe, RecoveryPlanner, riskOf } from './RecoveryPlanner.js';
import type {
  FailureKind,
  RecoveryRecord,
  ReplayBusinessOutcome,
  ReplayFailure,
  ReplayFailureCode,
  ReplayResult,
  ReplayStepRecord,
  ReplaySuccess,
} from './ReplayResult.js';
import { RunJournal } from './RunJournal.js';
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
 *
 * When a step does not succeed, the engine asks three questions in a fixed order before
 * it will call the run a failure:
 *
 * ```text
 * 1. Is this a state the capability declares?   -> business outcome, or a declared failure
 * 2. Is this a state the capability can clear?  -> recover, then retry the step
 * 3. Neither                                    -> hard failure, and stop
 * ```
 *
 * The order matters. A page saying "you do not have permission" is answered, not
 * dismissed and retried, and a state nobody wrote down is never touched at all: replay
 * stops rather than clicking an unknown dialog to see what happens.
 */

export interface ReplayEngineOptions {
  readonly surface: ComputerSurface;
  readonly logger: Logger;
  /**
   * The safety boundary. Required, because an engine with an optional guardrail has a
   * mode in which there is none, and that mode is the one that ships by accident.
   */
  readonly policy: PolicyEngine;
  /** Where the run is recorded. Defaults to writing nothing. */
  readonly evidence?: EvidenceRecorder;
  /** Waiting budgets, normally `AppConfig.surfaceTimeouts`. */
  readonly timeouts?: SurfaceTimeouts;
  /** Applies to every step that declares no budget of its own. */
  readonly stepTimeoutMs?: number;
  /** Injected in tests so a result is comparable; a run generates one otherwise. */
  readonly replayId?: string;
}

/** What the engine decided to do about a step that did not succeed. */
type StepResolution =
  | { readonly kind: 'retry' }
  | { readonly kind: 'result'; readonly result: ReplayResult }
  | { readonly kind: 'fail'; readonly failureKind: FailureKind };

interface RunContext {
  readonly replayId: string;
  readonly artifact: CapabilityArtifact;
  readonly logger: Logger;
  readonly journal: RunJournal;
  readonly started: number;
  readonly completedSteps: ReplayStepRecord[];
  readonly recoveries: RecoveryRecord[];
}

/**
 * What a failure knows, before the absent parts are dropped. The engine works with
 * `undefined` internally and `withoutAbsentKeys` produces the result, which under
 * `exactOptionalPropertyTypes` may not carry an explicitly undefined property.
 */
interface FailureDetail {
  readonly code: ReplayFailureCode;
  readonly kind: FailureKind;
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
  private readonly policy: PolicyEngine;
  private readonly evidence: EvidenceRecorder;
  private readonly timeouts: SurfaceTimeouts;
  private readonly stepTimeoutMs: number | undefined;
  private readonly replayId: string | undefined;
  /** Policy answers awaiting a journal write, see `onPolicyDecision`. */
  private readonly decisions: { step: CapabilityStep; decision: PolicyDecision }[] = [];

  constructor(options: ReplayEngineOptions) {
    this.surface = options.surface;
    this.logger = options.logger;
    this.policy = options.policy;
    this.evidence = options.evidence ?? NO_EVIDENCE;
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
      journal: new RunJournal({ logger, evidence: this.evidence }),
      started: performance.now(),
      completedSteps: [],
      recoveries: [],
    };

    // Input names only. A value can be a credential, and an input can be declared
    // sensitive, so nothing in this record can carry one.
    context.journal.runStarted({
      capabilityName: artifact.name,
      stepCount: artifact.steps.length,
      inputNames: artifact.inputs.map((input) => input.name),
    });

    try {
      return await this.execute(context, inputs);
    } catch (error) {
      if (error instanceof InvocationInputError) {
        // Nothing was touched, so there is no screen worth capturing.
        return await this.fail(context, {
          code: 'REPLAY_INPUTS_INVALID',
          kind: 'terminal',
          message: error.message,
        });
      }
      return await this.fail(context, {
        code: 'REPLAY_UNEXPECTED_STATE',
        kind: 'terminal',
        message: 'Replay stopped on a failure it could not classify',
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
      journal: context.journal,
      checkpoints,
      inputs,
      outputs,
      policy: this.policy,
      artifact,
      onPolicyDecision: (step, decision) => {
        // Queued rather than awaited: the executor's decision path stays synchronous,
        // and an evidence write must never sit between a policy answer and acting on it.
        this.decisions.push({ step, decision });
      },
    });
    const recovery = new RecoveryPlanner({
      surface: this.surface,
      logger,
      checkpoints,
      probeBudgetMs: this.probeBudget(),
      actionBudgetMs: this.stepTimeoutMs ?? this.timeouts.locatorMs + this.timeouts.actionMs,
    });

    for (const step of artifact.steps) {
      const budgetMs = stepBudgetMs(
        step,
        withoutAbsentKeys({ timeouts: this.timeouts, stepTimeoutMs: this.stepTimeoutMs }),
      );
      const outcome = await this.runStep(context, executor, recovery, step, budgetMs);
      if (outcome !== undefined) {
        return outcome;
      }
    }

    return await this.verify(context, checkpoints, outputs);
  }

  /**
   * Runs one step, recovering from recognized conditions until the step succeeds, the
   * recoveries run out, or the failure turns out to be something else.
   *
   * Returns a result only when the run must end. `undefined` means the step is done and
   * the next one may start.
   */
  private async runStep(
    context: RunContext,
    executor: StepExecutor,
    recovery: RecoveryPlanner,
    step: CapabilityStep,
    budgetMs: number,
  ): Promise<ReplayResult | undefined> {
    let attempts = 0;

    for (;;) {
      await context.journal.stepStarted(step, budgetMs);
      const outcome = await executor.execute(step, budgetMs);
      attempts += outcome.attempts;
      await this.flushDecisions(context);

      if (outcome.ok) {
        context.completedSteps.push({
          stepId: step.id,
          stepType: step.type,
          attempts,
          durationMs: outcome.durationMs,
        });
        await context.journal.stepCompleted(step, attempts, outcome.durationMs);
        return undefined;
      }

      const resolved = await this.resolveStepFailure(context, recovery, step, outcome.failure);
      if (resolved.kind === 'retry') {
        continue;
      }
      if (resolved.kind === 'result') {
        return resolved.result;
      }
      return await this.reportStepFailure(
        context,
        step,
        attempts,
        outcome.failure,
        resolved.failureKind,
      );
    }
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
      await context.journal.checkpoint('successCondition', outcome);
      const declared = await this.findDeclaredState(context);
      if (declared !== undefined) {
        return declared;
      }
      return await this.fail(context, {
        code: 'REPLAY_SUCCESS_CONDITION_FAILED',
        kind: 'terminal',
        message: `Every step ran, but the capability expected ${outcome.expected} and the surface showed ${outcome.observed}`,
        expected: outcome.expected,
        observed: outcome.observed,
      });
    }
    await context.journal.checkpoint('successCondition', outcome);

    const collected = outputs.collect();
    if (!collected.ok) {
      // A run that reached its success state but could not produce what it promised is
      // still a failure: half an answer is worse than none, because a caller cannot tell.
      return await this.fail(context, {
        code: collected.problem.code,
        kind: 'terminal',
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
      recoveries: context.recoveries,
      durationMs: this.elapsed(context),
    };
    context.journal.runCompleted({
      status: result.status,
      outputNames: Object.keys(result.outputs),
      completedSteps: result.completedSteps.length,
      recoveries: result.recoveries.length,
      durationMs: result.durationMs,
    });
    return result;
  }

  /**
   * The three questions, in order, that decide what a failed step means.
   *
   * A declared application state ends the run with an answer rather than a diagnosis. A
   * recognized clearable state asks for the step to be repeated. Anything else stops.
   */
  private async resolveStepFailure(
    context: RunContext,
    recovery: RecoveryPlanner,
    step: CapabilityStep,
    failure: StepFailure,
  ): Promise<StepResolution> {
    await context.journal.stepFailed(step, {
      code: failure.code,
      expected: failure.expected,
      observed: failure.observed,
    });

    // A guardrail is not a state to interpret or an obstacle to clear. Asking the page
    // what it meant, or dismissing something and trying again, would both be the
    // automation arguing with the rule that just stopped it.
    if (isPolicyDenial(failure.code)) {
      return { kind: 'fail', failureKind: 'policy' };
    }

    // A control that could not be found or operated is an automation problem whatever
    // the screen says, so only a settled state is worth interpreting.
    if (failure.conditionFailed) {
      const declared = await this.findDeclaredState(context, step.id);
      if (declared !== undefined) {
        return { kind: 'result', result: declared };
      }
    }

    return await this.tryRecovery(context, recovery, step, failure);
  }

  /**
   * Recognizes a declared condition, clears it, and asks for the step to be repeated.
   *
   * Bounded three ways: only failures an interstitial could plausibly cause are
   * eligible, only a step that is safe to repeat is retried, and each declared condition
   * may fire only as many times as the artifact allowed.
   */
  private async tryRecovery(
    context: RunContext,
    recovery: RecoveryPlanner,
    step: CapabilityStep,
    failure: StepFailure,
  ): Promise<StepResolution> {
    const { artifact, logger } = context;
    if (artifact.recoveries.length === 0 || !isRecoveryEligible(failure.code)) {
      return { kind: 'fail', failureKind: 'terminal' };
    }

    if (!isRetrySafe(step)) {
      // Clearing a dialog and then repeating a submit is how one request becomes two.
      context.journal.note('Recovery Not Attempted', {
        stepId: step.id,
        stepType: step.type,
        risk: riskOf(step),
        reason: 'a step that changes the application is not repeated automatically',
      });
      return { kind: 'fail', failureKind: 'terminal' };
    }

    const started = performance.now();
    const recognized = await recovery.recognize(artifact.recoveries);
    if (recognized === undefined) {
      // Either nothing matched, or everything that matched has already been spent. The
      // second case is the one worth naming, because the run met a state it recognizes
      // and could not get past it.
      if (context.recoveries.length > 0) {
        return { kind: 'fail', failureKind: 'recoveryExhausted' };
      }
      return { kind: 'fail', failureKind: 'terminal' };
    }

    const { definition } = recognized;
    await context.journal.recoveryAttempted({
      code: definition.code,
      stepId: step.id,
      description: definition.description,
    });

    const cleared = await recovery.apply(definition, step.id);
    const record: RecoveryRecord = {
      code: definition.code,
      stepId: step.id,
      attempt: recovery.attemptsSpent(definition),
      succeeded: cleared,
      durationMs: Math.round(performance.now() - started),
    };
    context.recoveries.push(record);

    if (!cleared) {
      return { kind: 'fail', failureKind: 'recoveryExhausted' };
    }
    logger.info('Recovery Attempt Succeeded', {
      code: definition.code,
      stepId: step.id,
      attempt: record.attempt,
    });
    return { kind: 'retry' };
  }

  /** Turns a step failure into the run's final failure result. */
  private async reportStepFailure(
    context: RunContext,
    step: CapabilityStep,
    attempts: number,
    failure: StepFailure,
    kind: FailureKind,
  ): Promise<ReplayFailure> {
    if (kind === 'policy') {
      return await this.fail(context, {
        code: failure.code,
        kind,
        message: failure.message,
        stepId: step.id,
        stepType: step.type,
        expected: failure.expected,
        observed: failure.observed,
      });
    }

    if (kind === 'recoveryExhausted') {
      const codes = context.recoveries.map((record) => record.code);
      await context.journal.recoveryExhausted({ stepId: step.id, codes });
      return await this.fail(context, {
        code: 'REPLAY_RECOVERY_EXHAUSTED',
        kind,
        message: `Step "${step.id}" (${step.type}) met a recognized condition that did not clear within its declared attempts`,
        stepId: step.id,
        stepType: step.type,
        attempts,
        expected: failure.expected,
        observed: failure.observed,
        cause: failure.cause,
      });
    }

    return await this.fail(context, {
      code: failure.code,
      kind,
      message: failure.message,
      stepId: step.id,
      stepType: step.type,
      attempts,
      expected: failure.expected,
      observed: failure.observed,
      cause: failure.cause,
    });
  }

  /**
   * The first declared application state that currently holds, as a finished result.
   *
   * The artifact decides what each declared state means. Most are answers the caller
   * asked for; one marked `failure` is a state the application is entitled to show and
   * the automation is not entitled to push past, such as a permission denial. Deciding
   * that here, from a declaration, is what keeps replay from classifying by matching
   * page text against a list baked into the engine.
   */
  private async findDeclaredState(
    context: RunContext,
    stepId?: string,
  ): Promise<ReplayResult | undefined> {
    const { artifact } = context;
    if (artifact.businessOutcomes.length === 0) {
      return undefined;
    }

    const checkpoints = new CheckpointEvaluator({ surface: this.surface });
    for (const outcome of artifact.businessOutcomes) {
      const observed = await this.matches(checkpoints, outcome);
      if (!observed) {
        continue;
      }

      if (outcome.disposition === 'failure') {
        await context.journal.declaredFailureDetected({ code: outcome.code, stepId });
        return await this.fail(context, {
          code: outcome.code,
          kind: 'terminal',
          message: outcome.description,
          stepId,
        });
      }

      await context.journal.businessOutcomeDetected({ code: outcome.code, stepId });
      const result: ReplayBusinessOutcome = withoutAbsentKeys({
        status: 'businessOutcome' as const,
        replayId: context.replayId,
        capabilityId: artifact.id,
        capabilityVersion: artifact.version,
        code: outcome.code,
        message: outcome.description,
        completedSteps: context.completedSteps,
        recoveries: context.recoveries,
        durationMs: this.elapsed(context),
        stepId,
      });
      context.journal.runCompleted({
        status: result.status,
        code: result.code,
        completedSteps: result.completedSteps.length,
        durationMs: result.durationMs,
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
      const evaluated = await checkpoints.evaluate(outcome.condition, this.probeBudget());
      return evaluated.passed;
    } catch {
      return false;
    }
  }

  /**
   * The single funnel every failure result passes through, and therefore the one place
   * the richer failure signal is captured.
   *
   * One screenshot per run, taken at the moment the run gives up, rather than one per
   * step. A capture of every step would be mostly identical images and a much larger
   * chance of storing something sensitive, and the frame that matters is the last one.
   */
  private async fail(context: RunContext, detail: FailureDetail): Promise<ReplayFailure> {
    await this.captureFailureFrame(context, detail);

    const result: ReplayFailure = withoutAbsentKeys({
      status: 'failure' as const,
      replayId: context.replayId,
      capabilityId: context.artifact.id,
      capabilityVersion: context.artifact.version,
      completedSteps: context.completedSteps,
      recoveries: context.recoveries,
      durationMs: this.elapsed(context),
      code: detail.code,
      kind: detail.kind,
      message: detail.message,
      stepId: detail.stepId,
      stepType: detail.stepType,
      expected: detail.expected,
      observed: detail.observed,
      attempts: detail.attempts,
      cause: detail.cause,
    });
    context.journal.runCompleted({
      status: result.status,
      kind: result.kind,
      code: result.code,
      stepId: result.stepId,
      completedSteps: result.completedSteps.length,
      recoveries: result.recoveries.length,
      durationMs: result.durationMs,
    });
    return result;
  }

  /**
   * Captures the failing screen, except where there is nothing to capture.
   *
   * A rejected invocation never touched the surface, and a policy denial happened before
   * the action, so a frame taken then shows whatever preceded it. The second is still
   * worth having: it is what the operator sees when asking why the run stopped.
   */
  private async captureFailureFrame(context: RunContext, detail: FailureDetail): Promise<void> {
    if (detail.code === 'REPLAY_INPUTS_INVALID') {
      return;
    }
    await context.journal.captureFailure(this.surface, String(detail.code));
  }

  /** Writes the policy answers the executor queued while it was running. */
  private async flushDecisions(context: RunContext): Promise<void> {
    const pending = this.decisions.splice(0, this.decisions.length);
    for (const entry of pending) {
      await context.journal.policyEvaluated(entry.step, entry.decision);
    }
  }

  /** See `probeBudgetMs`: classification asks about a settled page, it does not wait. */
  private probeBudget(): number {
    return probeBudgetMs(this.timeouts);
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
