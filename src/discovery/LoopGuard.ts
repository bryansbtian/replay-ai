import type { DiscoveryFailureCode } from './DiscoveryResult.js';

/**
 * Mechanical protection against a loop that will not end.
 *
 * None of this asks the model whether it is stuck. A model that has lost the thread is
 * exactly the thing that cannot tell you it has, so every limit here is counted by the
 * application and none of them is visible to the model as something it could argue with
 * or raise.
 *
 * Five limits, each guarding a different way a run fails to terminate:
 *
 * ```text
 * steps        the run is making decisions but not progress
 * deadline     something is slow rather than wrong
 * same action  the model keeps proposing the identical thing
 * same state   actions are landing and the application is not moving
 * failures     the proposed actions cannot be carried out at all
 * ```
 */

export interface LoopLimits {
  /** Model decisions the run may carry out. Conservative: discovery is expensive. */
  readonly maxSteps: number;
  /** Wall-clock ceiling for the whole run, model calls and surface work included. */
  readonly timeoutMs: number;
  /** How many times the same action may be proposed before the run is called stuck. */
  readonly maxRepeatedActions: number;
  /** How many actions in a row may leave the screen unchanged. */
  readonly maxUnchangedStates: number;
  /** How many proposed actions in a row may fail to be carried out. */
  readonly maxConsecutiveFailures: number;
}

/**
 * Deliberately small numbers. A workflow a person would describe in a sentence takes a
 * handful of steps, and a run that has spent fifteen decisions without finishing has
 * usually misunderstood the application rather than nearly solved it.
 */
export const DEFAULT_LOOP_LIMITS: LoopLimits = {
  maxSteps: 15,
  timeoutMs: 180_000,
  maxRepeatedActions: 3,
  maxUnchangedStates: 3,
  maxConsecutiveFailures: 3,
};

/** Why the guard stopped the run, in the result's own vocabulary. */
export interface LoopStop {
  readonly code: DiscoveryFailureCode;
  readonly message: string;
}

export interface LoopGuardOptions {
  readonly limits: LoopLimits;
  /** Monotonic clock, injected in tests. Never `Date.now`: a run must survive a clock change. */
  readonly now?: () => number;
}

export class LoopGuard {
  private readonly limits: LoopLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly actionCounts = new Map<string, number>();
  private lastState: string | undefined;
  private unchangedStates = 0;
  private consecutiveFailures = 0;

  constructor(options: LoopGuardOptions) {
    this.limits = options.limits;
    this.now = options.now ?? ((): number => performance.now());
    this.startedAt = this.now();
  }

  /** How much of the run budget is left, never negative. */
  remainingMs(): number {
    const elapsed = this.now() - this.startedAt;
    return Math.max(0, Math.round(this.limits.timeoutMs - elapsed));
  }

  elapsedMs(): number {
    return Math.round(this.now() - this.startedAt);
  }

  get maxSteps(): number {
    return this.limits.maxSteps;
  }

  /**
   * Asked before a turn begins, so a run that is out of budget spends nothing more.
   *
   * The deadline is checked here *and* enforced around every model call and every surface
   * action through the shared deadline guard, because a limit only checked between turns
   * would be no limit at all against an operation that hangs inside one.
   */
  beforeStep(step: number): LoopStop | undefined {
    if (step > this.limits.maxSteps) {
      return {
        code: 'DISCOVERY_MAX_STEPS_EXCEEDED',
        message: `Discovery stopped after its limit of ${this.limits.maxSteps} steps.`,
      };
    }
    if (this.remainingMs() <= 0) {
      return {
        code: 'DISCOVERY_DEADLINE_EXCEEDED',
        message: `Discovery stopped after its limit of ${this.limits.timeoutMs}ms.`,
      };
    }
    return undefined;
  }

  /**
   * Counts a proposed action by fingerprint.
   *
   * Counted before the action runs, not after, so a run that would click the same button
   * a fourth time is stopped rather than performing it and then noticing.
   */
  recordAction(fingerprint: string): LoopStop | undefined {
    const seen = (this.actionCounts.get(fingerprint) ?? 0) + 1;
    this.actionCounts.set(fingerprint, seen);
    if (seen > this.limits.maxRepeatedActions) {
      return {
        code: 'DISCOVERY_REPEATED_ACTION',
        message: `Discovery proposed the same action ${seen} times without making progress.`,
      };
    }
    return undefined;
  }

  /**
   * Counts an observation taken after an action.
   *
   * An unchanged screen is not by itself wrong: filling a field changes a value the
   * observation deliberately does not carry. Several in a row is the signal, which is why
   * this counts consecutive repeats rather than raising on the first one.
   */
  recordState(fingerprint: string): LoopStop | undefined {
    if (this.lastState === fingerprint) {
      this.unchangedStates += 1;
    } else {
      this.unchangedStates = 0;
      this.lastState = fingerprint;
    }

    if (this.unchangedStates >= this.limits.maxUnchangedStates) {
      return {
        code: 'DISCOVERY_REPEATED_STATE',
        message: `The application showed the same state after ${this.unchangedStates} consecutive actions.`,
      };
    }
    return undefined;
  }

  /** Records the first observation, so the state guard has something to compare against. */
  seedState(fingerprint: string): void {
    this.lastState = fingerprint;
    this.unchangedStates = 0;
  }

  /**
   * Counts an action that could not be carried out.
   *
   * A single failure is fed back to the model, which is the point of an observe-decide-act
   * loop: a locator that did not resolve is information. A run of them means the model is
   * describing an application that is not there.
   */
  recordOutcome(succeeded: boolean): LoopStop | undefined {
    if (succeeded) {
      this.consecutiveFailures = 0;
      return undefined;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.limits.maxConsecutiveFailures) {
      return {
        code: 'DISCOVERY_DEAD_END',
        message: `${this.consecutiveFailures} proposed actions in a row could not be carried out.`,
      };
    }
    return undefined;
  }
}
