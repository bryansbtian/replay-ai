import type { EvidenceRecorder } from '../evidence/index.js';
import {
  DeadlineExceededError,
  withDeadline,
  type InterventionHandler,
} from '../execution/index.js';
import { ModelError, type LLMClient } from '../llm/index.js';
import type { Logger } from '../logging/logger.js';
import { isAllowed, type PolicyDenied, type PolicyEngine } from '../policy/index.js';
import { sanitizeUrl } from '../redaction.js';
import {
  SurfaceUnavailableError,
  type ComputerSurface,
  type Observation,
  type SurfaceTimeouts,
} from '../surfaces/index.js';

import {
  agentDecisionJsonSchema,
  describeAction,
  fingerprintAction,
  parseAgentDecision,
  shouldChangeScreen,
  type AgentAction,
  type AgentDecision,
  type CompleteDecision,
} from './AgentDecision.js';
import { DiscoveryJournal } from './DiscoveryJournal.js';
import type {
  DiscoveryEscalation,
  DiscoveryFailure,
  DiscoveryFailureCode,
  DiscoveryFailureKind,
  DiscoveryResult,
  DiscoverySuccess,
} from './DiscoveryResult.js';
import {
  fingerprintObservation,
  summarizeObservation,
  type ActionOutcome,
  type DiscoveredValue,
  type DiscoveryInput,
  type DiscoveryTrace,
  type DiscoveryTraceEntry,
} from './DiscoveryTrace.js';
import { DEFAULT_LOOP_LIMITS, LoopGuard, type LoopLimits, type LoopStop } from './LoopGuard.js';
import { describeDenial, policyContextFor } from './policyGate.js';
import {
  buildInstruction,
  DISCOVERY_SYSTEM_PROMPT,
  MAX_HISTORY_ENTRIES,
  type StepHistoryEntry,
} from './prompt.js';

/**
 * The observe, decide, act loop.
 *
 * One turn is: show the model what the application is showing, ask for one decision,
 * prove the answer is a decision, ask the safety boundary whether it may happen, carry it
 * out through the surface, and look again. The model contributes exactly one thing to
 * that sequence, which is the choice of next action, and every other step is the
 * application deciding whether to honour it.
 *
 * Three properties are structural rather than remembered:
 *
 * Nothing reaches the surface that was not parsed by `parseAgentDecision` and then
 * allowed by `PolicyEngine`, because `perform` is private and the only call to it sits
 * after both. A model cannot argue with either: a validation failure is a rejected
 * response, and a denial is the deployment's answer regardless of what the summary claims
 * about the action being safe.
 *
 * Termination does not depend on the model noticing it is stuck. Every limit is counted
 * by `LoopGuard`, which the model cannot see or raise.
 *
 * The model never sees a growing transcript. It sees the current screen, a bounded recent
 * history, and the values read so far, which is what the next decision actually depends
 * on. That keeps the cost of a run roughly linear in its length instead of quadratic.
 */

/** Where a run happens. The name is for the prompt; the entry point is where it starts. */
export interface TargetApplication {
  readonly name: string;
  /** Absolute URL. Checked by policy before it is opened, like any other navigation. */
  readonly entryPoint: string;
}

/**
 * What a caller asks for.
 *
 * Two fields, both of them the operator's own words. Everything a run needs in order to
 * act (the surface, the guardrail, the recorder, the model client) is a dependency of the
 * engine rather than part of the request, so a request can never smuggle in a credential,
 * a page object, or a relaxed policy.
 */
export interface DiscoveryRequest {
  readonly goal: string;
  readonly target: TargetApplication;
  /**
   * The values this run should use, each under the name it will carry as a capability
   * input.
   *
   * Optional, because discovery works without them: a goal naming a reference in prose is
   * enough for a model to type it. What they add is the ability to compile the run
   * afterwards. A finished trace cannot say which of the strings in it were invocation
   * data, and a compiler that guessed would eventually parameterize a workflow constant.
   */
  readonly inputs?: readonly DiscoveryInput[];
}

export interface DiscoveryEngineOptions {
  readonly surface: ComputerSurface;
  readonly llm: LLMClient;
  readonly policy: PolicyEngine;
  readonly evidence: EvidenceRecorder;
  readonly logger: Logger;
  readonly timeouts: SurfaceTimeouts;
  /** Shared with the evidence directory, so a run and its record have one identity. */
  readonly runId: string;
  readonly limits?: LoopLimits;
  /**
   * Where the run asks for a person when the model says it should not decide something.
   *
   * Absent by default, in which case an escalation is terminal exactly as it was before.
   */
  readonly intervention?: InterventionHandler;
  /** Monotonic clock, injected in tests. */
  readonly now?: () => number;
}

/**
 * How many times one turn may ask for a decision.
 *
 * Two, and only when the first answer failed validation rather than the provider failing.
 * A small model that returned a nearly-right object usually returns a right one when told
 * which field was wrong, and re-asking once is cheaper than spending the turn. It is not a
 * retry loop: a second invalid answer ends the run, so a model that cannot produce a
 * decision cannot burn a budget proving it.
 */
const MAX_DECISION_ATTEMPTS = 2;

/** Ceiling for one model call, further bounded by whatever is left of the run deadline. */
const MODEL_CALL_TIMEOUT_MS = 90_000;

/** Raised internally when the surface itself has gone away, which ends the run. */
class SurfaceGoneError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SurfaceGoneError';
  }
}

/** What performing one action produced. A failure here is a turn outcome, not a verdict. */
interface PerformResult {
  readonly outcome: ActionOutcome;
  /** Present when the action was an extraction that succeeded. */
  readonly extracted?: DiscoveredValue;
}

/**
 * Reduces a value to the characters worth comparing.
 *
 * Completion verification asks whether a value the model reported is one the application
 * actually showed, and an application shows `$1,024.50` where a model reports `1024.50`.
 * Dropping everything but letters, digits, and the decimal point makes those the same
 * string without making two different balances the same string.
 */
function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

export class DiscoveryEngine {
  private readonly surface: ComputerSurface;
  private readonly llm: LLMClient;
  private readonly policy: PolicyEngine;
  private readonly journal: DiscoveryJournal;
  private readonly timeouts: SurfaceTimeouts;
  private readonly runId: string;
  private readonly limits: LoopLimits;
  private readonly now: (() => number) | undefined;
  private readonly intervention: InterventionHandler | undefined;

  constructor(options: DiscoveryEngineOptions) {
    this.surface = options.surface;
    this.llm = options.llm;
    this.policy = options.policy;
    this.journal = new DiscoveryJournal({
      logger: options.logger,
      evidence: options.evidence,
    });
    this.timeouts = options.timeouts;
    this.runId = options.runId;
    this.limits = options.limits ?? DEFAULT_LOOP_LIMITS;
    this.now = options.now;
    this.intervention = options.intervention;
  }

  /**
   * Runs one discovery and returns what happened.
   *
   * Never throws for anything the run met on the way. A model that failed, a guardrail
   * that refused, a surface that broke, and a limit that fired are all outcomes a caller
   * has to describe rather than exceptions it has to guess at.
   */
  async discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
    const guard = new LoopGuard({ limits: this.limits, ...(this.now && { now: this.now }) });
    const trace: DiscoveryTraceEntry[] = [];
    const history: StepHistoryEntry[] = [];
    const discovered: DiscoveredValue[] = [];
    const target = sanitizeUrl(request.target.entryPoint);

    const context = { guard, trace, history, discovered, request, target };

    this.journal.started({
      runId: this.runId,
      goal: request.goal,
      target,
      application: request.target.name,
      maxSteps: guard.maxSteps,
      timeoutMs: this.limits.timeoutMs,
    });

    try {
      return await this.run(context);
    } catch (error) {
      if (error instanceof SurfaceGoneError) {
        return await this.fail(context, {
          kind: 'terminal',
          code: 'DISCOVERY_SURFACE_UNAVAILABLE',
          message: `The surface became unavailable: ${error.detail}`,
        });
      }
      throw error;
    }
  }

  /** The loop proper, split out so that a broken surface has one handler above it. */
  private async run(context: RunContext): Promise<DiscoveryResult> {
    const { guard, trace, history, discovered, request } = context;

    // The opening navigation is an action like any other, so it is asked of policy like
    // any other. Doing it here rather than making the model spend a turn on it means the
    // model's first decision is taken while looking at the application.
    const entry: AgentAction = { type: 'navigate', url: request.target.entryPoint };
    const entryDecision = this.policy.evaluate(policyContextFor(entry, 0));
    await this.journal.policyEvaluated(0, entry, entryDecision);
    if (!isAllowed(entryDecision)) {
      return await this.denied(context, entry, entryDecision);
    }

    await this.journal.actionStarted(0, entry, this.timeouts.navigationMs);
    const opened = await this.perform(entry, this.timeouts.navigationMs, 0);
    if (!opened.outcome.ok) {
      await this.journal.actionFailed(0, {
        actionType: entry.type,
        code: opened.outcome.code,
        detail: opened.outcome.detail,
      });
      return await this.fail(context, {
        kind: 'terminal',
        code: 'DISCOVERY_DEAD_END',
        message: `The application could not be opened: ${opened.outcome.detail ?? 'unknown reason'}`,
        lastAction: describeAction(entry),
      });
    }
    await this.journal.actionCompleted(0, entry, opened.outcome.durationMs);

    let observation = await this.observe();
    let fingerprint = fingerprintObservation(observation);
    guard.seedState(fingerprint);
    // Nothing has happened yet, so the first screen is not "unchanged" in the sense the
    // model is told about.
    let stateUnchanged = false;

    for (let step = 1; ; step += 1) {
      const limit = guard.beforeStep(step);
      if (limit !== undefined) {
        return await this.stopped(context, limit);
      }

      const summary = summarizeObservation(observation);
      await this.journal.observed(step, summary);

      const decided = await this.decide(step, {
        goal: request.goal,
        applicationName: request.target.name,
        entryPoint: request.target.entryPoint,
        step,
        maxSteps: guard.maxSteps,
        observation,
        history: history.slice(-MAX_HISTORY_ENTRIES),
        discovered,
        inputs: request.inputs ?? [],
        stateUnchanged,
        guard,
      });

      if (!decided.ok) {
        return await this.fail(context, decided.failure);
      }
      const decision = decided.decision;

      if (decision.type === 'escalate') {
        const handled = await this.offerIntervention(context, decision.reason);
        if (handled.kind === 'escalated') {
          return handled.result;
        }
        // A person changed the application while the run was paused, so everything the
        // model was looking at is now a description of a screen that no longer exists.
        // The next decision is taken from a fresh observation, and the turn is not spent.
        observation = await this.observe();
        fingerprint = fingerprintObservation(observation);
        guard.seedState(fingerprint);
        stateUnchanged = false;
        step -= 1;
        continue;
      }

      if (decision.type === 'complete') {
        return await this.complete(context, decision, observation);
      }

      const action = decision.action;

      // Counted before the action runs, so a fourth identical click is refused rather
      // than performed and then noticed.
      const repeated = guard.recordAction(fingerprintAction(action));
      if (repeated !== undefined) {
        return await this.stopped(context, repeated, describeAction(action));
      }

      const verdict = this.policy.evaluate(policyContextFor(action, step));
      await this.journal.policyEvaluated(step, action, verdict);
      if (!isAllowed(verdict)) {
        return await this.denied(context, action, verdict);
      }

      const budget = this.budgetFor(action, guard.remainingMs());
      await this.journal.actionStarted(step, action, budget);
      const performed = await this.perform(action, budget, step);

      if (performed.outcome.ok) {
        await this.journal.actionCompleted(step, action, performed.outcome.durationMs);
      } else {
        await this.journal.actionFailed(step, {
          actionType: action.type,
          code: performed.outcome.code,
          detail: performed.outcome.detail,
        });
      }

      if (performed.extracted !== undefined) {
        discovered.push(performed.extracted);
      }

      history.push(toHistoryEntry(step, decision.summary, performed.outcome));

      const after = await this.observe();
      const afterFingerprint = fingerprintObservation(after);
      // Only for an action the screen should have answered, see `shouldChangeScreen`.
      stateUnchanged = afterFingerprint === fingerprint && shouldChangeScreen(action);
      fingerprint = afterFingerprint;

      trace.push({
        step,
        observation: summary,
        decisionType: decision.type,
        summary: decision.summary,
        action,
        policy: verdict.outcome,
        outcome: performed.outcome,
        stateAfter: summarizeObservation(after),
      });
      observation = after;

      const stuck = guard.recordOutcome(performed.outcome.ok);
      if (stuck !== undefined) {
        return await this.stopped(context, stuck, describeAction(action));
      }

      // Only actions the screen should have answered are put to the state guard. An
      // observation carries the controls on a screen and not the values in them, so a
      // `fill` or an `extract` leaves it identical by design, and counting those would
      // report the observation model as though it were a stuck application. Termination is
      // not weakened: a model looping on either is caught by the repeated-action guard, and
      // one that cannot carry them out is caught by the dead-end guard.
      if (shouldChangeScreen(action)) {
        const unchanged = guard.recordState(afterFingerprint);
        if (unchanged !== undefined) {
          return await this.stopped(context, unchanged, describeAction(action));
        }
      }
    }
  }

  /**
   * Asks the model for one decision and proves the answer is one.
   *
   * A provider failure and an unusable answer are kept apart all the way out, because they
   * are different people's problems: the first says the model layer is broken, the second
   * says this model cannot drive this application.
   */
  private async decide(step: number, input: DecisionInput): Promise<DecisionOutcome> {
    let rejection: string | undefined;

    for (let attempt = 1; attempt <= MAX_DECISION_ATTEMPTS; attempt += 1) {
      const budget = Math.min(input.guard.remainingMs(), MODEL_CALL_TIMEOUT_MS);
      if (budget <= 0) {
        return {
          ok: false,
          failure: {
            kind: 'terminal',
            code: 'DISCOVERY_DEADLINE_EXCEEDED',
            message: `Discovery stopped after its limit of ${this.limits.timeoutMs}ms.`,
          },
        };
      }

      await this.journal.modelRequested(step, { attempt, budgetMs: budget });

      const instruction = buildInstruction({
        goal: input.goal,
        applicationName: input.applicationName,
        entryPoint: input.entryPoint,
        step: input.step,
        maxSteps: input.maxSteps,
        observation: input.observation,
        history: input.history,
        discovered: input.discovered,
        inputs: input.inputs,
        stateUnchanged: input.stateUnchanged,
        ...(rejection !== undefined && { rejection }),
      });

      let text: string;
      let cost: Record<string, unknown>;
      try {
        const response = await withDeadline(
          () =>
            this.llm.complete({
              system: DISCOVERY_SYSTEM_PROMPT,
              instruction,
              responseSchema: agentDecisionJsonSchema,
              timeoutMs: budget,
            }),
          budget,
        );
        text = response.text;
        cost = {
          model: response.model,
          // Named without the word "token": the shared redaction rule replaces any
          // field whose name looks credential-bearing, and a count is not one.
          inputSize: response.inputTokens,
          outputSize: response.outputTokens,
          modelDurationMs: response.durationMs,
        };
      } catch (error) {
        return { ok: false, failure: toProviderFailure(error) };
      }

      const parsed = parseAgentDecision(text);
      if (parsed.ok) {
        await this.journal.decided(step, parsed.decision, cost);
        return { ok: true, decision: parsed.decision };
      }

      // The text itself is never recorded, only what was wrong with it. That is enough to
      // debug a prompt and carries nothing the provider wrote.
      await this.journal.decisionRejected(step, parsed.issue);
      rejection = parsed.issue;
    }

    return {
      ok: false,
      failure: {
        kind: 'terminal',
        code: 'DISCOVERY_MODEL_RESPONSE_INVALID',
        message: `The model did not return a valid decision in ${MAX_DECISION_ATTEMPTS} attempts: ${rejection ?? 'unknown reason'}`,
      },
    };
  }

  /**
   * Carries out one allowed action.
   *
   * Everything reaches the application through `ComputerSurface`, which is why this file
   * has no idea a browser is involved. A failure is returned rather than thrown, because a
   * locator that did not resolve is information the next turn gets to react to, which is
   * the whole point of deciding one action at a time.
   */
  private async perform(
    action: AgentAction,
    budgetMs: number,
    step: number,
  ): Promise<PerformResult> {
    const started = performance.now();
    const options = { timeoutMs: budgetMs };

    try {
      return await withDeadline(async (): Promise<PerformResult> => {
        switch (action.type) {
          case 'navigate': {
            const result = await this.surface.navigate(action.url, options);
            return { outcome: { ok: true, durationMs: result.durationMs } };
          }
          case 'click': {
            const result = await this.surface.click(action.target, options);
            return { outcome: { ok: true, durationMs: result.durationMs } };
          }
          case 'fill': {
            const result = await this.surface.fill(action.target, action.value, options);
            return { outcome: { ok: true, durationMs: result.durationMs } };
          }
          case 'extract': {
            const result = await this.surface.extract(action.target, options);
            // A target that resolved to something with no content has not read the value.
            // Reporting that as a success would put an empty entry in the values the next
            // prompt shows, which reads as "already done" and is how a run talks itself
            // into extracting the same nothing over and over.
            if (result.value.trim() === '') {
              return {
                outcome: {
                  ok: false,
                  durationMs: result.durationMs,
                  code: 'EXTRACTION_EMPTY',
                  detail: `the control matched but contained no text, so "${action.name}" was not read`,
                },
              };
            }
            return {
              outcome: { ok: true, durationMs: result.durationMs },
              extracted: { name: action.name, value: result.value, step },
            };
          }
          case 'wait': {
            const result = await this.surface.waitFor(action.condition, options);
            if (result.satisfied) {
              return { outcome: { ok: true, durationMs: result.durationMs } };
            }
            return {
              outcome: {
                ok: false,
                durationMs: result.durationMs,
                code: 'CONDITION_NOT_SATISFIED',
                detail: `the expected state did not appear (observed ${result.observed})`,
              },
            };
          }
        }
      }, budgetMs);
    } catch (error) {
      if (error instanceof SurfaceUnavailableError) {
        throw new SurfaceGoneError(error.message);
      }
      return {
        outcome: {
          ok: false,
          durationMs: Math.round(performance.now() - started),
          ...describeActionFailure(error),
        },
      };
    }
  }

  private async observe(): Promise<Observation> {
    try {
      return await this.surface.observe();
    } catch (error) {
      if (error instanceof SurfaceUnavailableError) {
        throw new SurfaceGoneError(error.message);
      }
      throw error;
    }
  }

  /** Navigation gets the navigation budget; everything else gets the action budget. */
  private budgetFor(action: AgentAction, remainingMs: number): number {
    if (action.type === 'navigate') {
      return Math.min(this.timeouts.navigationMs, remainingMs);
    }
    return Math.min(this.timeouts.actionMs, remainingMs);
  }

  /**
   * Decides whether a claimed completion is one.
   *
   * Two checks, both against what the run can see rather than what the model asserted.
   * At least one action must have been carried out, so a model cannot open an application
   * and declare victory. And every value it reports must be a value the application
   * showed: either one the surface extracted during the run, or one visible in the final
   * observation.
   *
   * The limitation is worth stating. A goal that reads nothing and changes nothing is
   * accepted on the strength of the summary plus the fact that work happened, because
   * there is no goal-specific condition to check it against yet. Generating that condition
   * is Phase 8's job: compiling the run into a capability produces the checkpoint that
   * makes success mechanically verifiable, and until then this is the honest bound.
   */
  private async complete(
    context: RunContext,
    decision: CompleteDecision,
    observation: Observation,
  ): Promise<DiscoveryResult> {
    const { trace, discovered } = context;

    if (trace.length === 0) {
      return await this.fail(context, {
        kind: 'terminal',
        code: 'DISCOVERY_COMPLETION_UNVERIFIED',
        message: 'The model reported completion before carrying out any action.',
      });
    }

    const visible = normalizeForComparison(observation.textSummary);
    const read = discovered.map((value) => normalizeForComparison(value.value));

    for (const [name, value] of Object.entries(decision.outputs)) {
      const normalized = normalizeForComparison(value);
      if (normalized === '') {
        return await this.fail(context, {
          kind: 'terminal',
          code: 'DISCOVERY_COMPLETION_UNVERIFIED',
          message: `The model reported an empty value for "${name}".`,
        });
      }
      if (!visible.includes(normalized) && !read.includes(normalized)) {
        // The unsupported value is deliberately absent from the message: it is exactly the
        // sort of thing that turns out to be somebody's balance.
        return await this.fail(context, {
          kind: 'terminal',
          code: 'DISCOVERY_COMPLETION_UNVERIFIED',
          message: `The value the model reported for "${name}" does not appear in what the application showed.`,
        });
      }
    }

    const outputs: Record<string, string> = { ...decision.outputs };
    await this.journal.goalCompleted({
      runId: this.runId,
      stepCount: trace.length,
      durationMs: context.guard.elapsedMs(),
      outputNames: Object.keys(outputs),
      summary: decision.summary,
    });

    const success: DiscoverySuccess = {
      status: 'success',
      runId: this.runId,
      goal: context.request.goal,
      target: context.target,
      stepCount: trace.length,
      durationMs: context.guard.elapsedMs(),
      trace: this.traceOf(context, outputs),
      outputs,
      summary: decision.summary,
    };
    return success;
  }

  /**
   * The run as Phase 8 receives it.
   *
   * Assembled here rather than accumulated, because everything in it is already known:
   * the entries are the loop's own record, and the goal, application, and inputs are what
   * the caller asked for. The entry point is the real URL rather than the sanitized one a
   * result reports, because a compiled capability has to be able to navigate to it.
   */
  private traceOf(
    context: RunContext,
    outputs: Readonly<Record<string, string>> = {},
  ): DiscoveryTrace {
    return {
      runId: this.runId,
      goal: context.request.goal,
      application: {
        name: context.request.target.name,
        entryPoint: context.request.target.entryPoint,
      },
      inputs: context.request.inputs ?? [],
      entries: context.trace,
      discovered: context.discovered,
      outputs,
    };
  }

  private async denied(
    context: RunContext,
    action: AgentAction,
    decision: PolicyDenied,
  ): Promise<DiscoveryResult> {
    const reason = describeDenial(decision);

    // An action needing approval is not a refusal, it is a missing person. Phase 9 gives
    // it somewhere to go; today it is a terminal escalation so nothing proceeds without one.
    if (decision.outcome === 'confirmationRequired') {
      return await this.escalate(context, reason, 'policy', describeAction(action));
    }

    return await this.fail(context, {
      kind: 'policy',
      code: 'DISCOVERY_POLICY_BLOCKED',
      message: `${decision.code}: ${reason}`,
      lastAction: describeAction(action),
    });
  }

  /**
   * Asks for a person, and says whether the run may carry on.
   *
   * An escalation is a request rather than a verdict. When somebody takes the session,
   * resolves whatever the model would not decide, and hands it back, the honest answer is
   * that the run continues; leaving it permanently marked as escalated would describe a
   * run that needed help as one that never got any.
   */
  private async offerIntervention(
    context: RunContext,
    reason: string,
    lastAction?: string,
  ): Promise<{ kind: 'resumed' } | { kind: 'escalated'; result: DiscoveryEscalation }> {
    const handler = this.intervention;
    if (handler === undefined) {
      return {
        kind: 'escalated',
        result: await this.escalate(context, reason, 'model', lastAction),
      };
    }

    const outcome = await handler.request({
      source: 'discovery',
      reason: 'DISCOVERY_ESCALATION',
      subject: context.request.goal,
      code: 'DISCOVERY_ESCALATION_REQUESTED',
      detail: reason,
    });

    if (outcome.status !== 'resolved') {
      await handler.settle({ resumed: false, detail: outcome.reason });
      return {
        kind: 'escalated',
        result: await this.escalate(context, reason, 'model', lastAction),
      };
    }

    // Discovery has no stored step whose condition could be checked, and asking the model
    // whether a person fixed things would be replacing evidence with an opinion. What it
    // does instead is look again, which is the same thing it does every other turn.
    await handler.settle({ resumed: true });
    return { kind: 'resumed' };
  }

  private async escalate(
    context: RunContext,
    reason: string,
    source: 'model' | 'policy',
    lastAction?: string,
  ): Promise<DiscoveryEscalation> {
    await this.journal.escalationRequested({
      runId: this.runId,
      source,
      reason,
      stepCount: context.trace.length,
    });

    return {
      status: 'escalation',
      runId: this.runId,
      goal: context.request.goal,
      target: context.target,
      stepCount: context.trace.length,
      durationMs: context.guard.elapsedMs(),
      trace: this.traceOf(context),
      reason,
      source,
      ...(lastAction !== undefined && { lastAction }),
    };
  }

  private async stopped(
    context: RunContext,
    stop: LoopStop,
    lastAction?: string,
  ): Promise<DiscoveryFailure> {
    return await this.fail(context, {
      kind: 'terminal',
      code: stop.code,
      message: stop.message,
      ...(lastAction !== undefined && { lastAction }),
    });
  }

  private async fail(context: RunContext, detail: FailureDetail): Promise<DiscoveryFailure> {
    await this.journal.stopped({
      runId: this.runId,
      code: detail.code,
      kind: detail.kind,
      message: detail.message,
      stepCount: context.trace.length,
      durationMs: context.guard.elapsedMs(),
    });

    return {
      status: 'failure',
      runId: this.runId,
      goal: context.request.goal,
      target: context.target,
      stepCount: context.trace.length,
      durationMs: context.guard.elapsedMs(),
      trace: this.traceOf(context),
      kind: detail.kind,
      code: detail.code,
      message: detail.message,
      ...(detail.lastAction !== undefined && { lastAction: detail.lastAction }),
    };
  }
}

interface RunContext {
  readonly guard: LoopGuard;
  readonly trace: DiscoveryTraceEntry[];
  readonly history: StepHistoryEntry[];
  readonly discovered: DiscoveredValue[];
  readonly request: DiscoveryRequest;
  /** The entry point, sanitized once so every result reports the same string. */
  readonly target: string;
}

interface FailureDetail {
  readonly kind: DiscoveryFailureKind;
  readonly code: DiscoveryFailureCode;
  readonly message: string;
  readonly lastAction?: string;
}

interface DecisionInput {
  readonly goal: string;
  readonly applicationName: string;
  readonly entryPoint: string;
  readonly step: number;
  readonly maxSteps: number;
  readonly observation: Observation;
  readonly history: readonly StepHistoryEntry[];
  readonly discovered: readonly DiscoveredValue[];
  readonly inputs: readonly DiscoveryInput[];
  readonly stateUnchanged: boolean;
  readonly guard: LoopGuard;
}

type DecisionOutcome =
  | { readonly ok: true; readonly decision: AgentDecision }
  | { readonly ok: false; readonly failure: FailureDetail };

/**
 * Turns a model-layer failure into a run outcome.
 *
 * `DISCOVERY_MODEL_UNAVAILABLE` for every provider problem, with the provider's own code
 * in the message: a caller needs to know the model layer failed rather than the workflow,
 * and which of authentication, rate limiting, or an outage it was.
 */
function toProviderFailure(error: unknown): FailureDetail {
  if (error instanceof DeadlineExceededError) {
    return {
      kind: 'provider',
      code: 'DISCOVERY_MODEL_UNAVAILABLE',
      message: `MODEL_TIMEOUT: the model did not answer within ${error.timeoutMs}ms.`,
    };
  }
  if (error instanceof ModelError) {
    return {
      kind: 'provider',
      code: 'DISCOVERY_MODEL_UNAVAILABLE',
      message: `${error.failure}: ${error.message}`,
    };
  }
  return {
    kind: 'provider',
    code: 'DISCOVERY_MODEL_UNAVAILABLE',
    message: 'The model layer failed for an unrecognized reason.',
  };
}

/**
 * Renders a surface failure for the trace and for the next prompt.
 *
 * The code comes from the typed surface error, never from matching message text. The
 * detail is the first line only, because a browser call log belongs in a debugger rather
 * than in something the next model call is going to read.
 */
function describeActionFailure(error: unknown): { code: string; detail: string } {
  if (error instanceof DeadlineExceededError) {
    return { code: 'ACTION_TIMEOUT', detail: `the action did not settle in ${error.timeoutMs}ms` };
  }
  if (error instanceof Error) {
    return { code: codeOf(error), detail: error.message.split('\n')[0] ?? '' };
  }
  return { code: 'ACTION_FAILED', detail: 'the action failed for an unrecognized reason' };
}

/** The typed surface code when there is one, and the error class name when there is not. */
function codeOf(error: Error): string {
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error.name;
}

function toHistoryEntry(step: number, summary: string, outcome: ActionOutcome): StepHistoryEntry {
  if (outcome.ok) {
    return { step, summary, outcome: 'succeeded' };
  }
  return {
    step,
    summary,
    outcome: 'failed',
    ...(outcome.detail !== undefined && { detail: outcome.detail }),
  };
}
