import type { Checkpoint, CheckpointType } from '../artifacts/index.js';
import type { ComputerSurface } from '../surfaces/index.js';

import { withDeadline } from './deadlines.js';

/**
 * Evaluates the artifact's one condition model against a surface.
 *
 * Checkpoints are why a replay is worth trusting. An action that returned without
 * throwing proves that a control was found and pressed, not that the workflow reached
 * the state it was recorded to reach, and those two are different every time an
 * application answers a click with an error banner.
 *
 * One evaluator serves all four uses of the model (a `wait` step, a `checkpoint` step,
 * a business outcome, and the capability's success condition), because they ask one
 * question. What differs is how the caller reacts to the answer, which is the caller's
 * business rather than the evaluator's.
 *
 * The result keeps what was expected next to what was observed. A bare boolean is
 * cheaper to produce and useless in a failure report.
 */

export interface CheckpointOutcome {
  readonly type: CheckpointType;
  readonly passed: boolean;
  /** Title Case rendering of the assertion, for logs and failure context. */
  readonly expected: string;
  /** Short rendering of what the surface showed. */
  readonly observed: string;
  readonly durationMs: number;
}

/** Reads as a sentence in a failure message, so it is written the way it is read. */
export function describeCheckpoint(checkpoint: Checkpoint): string {
  switch (checkpoint.type) {
    case 'targetVisible':
      return `Target "${checkpoint.target.description}" Is Visible`;
    case 'targetContainsText':
      return `Target "${checkpoint.target.description}" Contains "${checkpoint.text}"`;
    case 'textVisible':
      return `Text "${checkpoint.text}" Is Visible`;
    case 'urlMatches':
      return `URL Matches /${checkpoint.pattern}/`;
  }
}

export interface CheckpointEvaluatorOptions {
  readonly surface: ComputerSurface;
}

export class CheckpointEvaluator {
  private readonly surface: ComputerSurface;

  constructor(options: CheckpointEvaluatorOptions) {
    this.surface = options.surface;
  }

  /**
   * Waits for the condition through the surface and reports what happened.
   *
   * The wait itself belongs to the surface: only an implementation can wait on a state
   * natively, and an evaluator that polled would be putting a fixed delay back into the
   * one layer that must not have one.
   */
  async evaluate(checkpoint: Checkpoint, budgetMs: number): Promise<CheckpointOutcome> {
    const observation = await withDeadline(
      () => this.surface.waitFor(checkpoint, { timeoutMs: budgetMs }),
      budgetMs,
    );

    return {
      type: checkpoint.type,
      passed: observation.satisfied,
      expected: describeCheckpoint(checkpoint),
      observed: observation.observed,
      durationMs: observation.durationMs,
    };
  }
}
