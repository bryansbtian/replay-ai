import {
  ArtifactValidationError,
  CapabilityNotFoundError,
  parseCapabilityArtifact,
  type CapabilityArtifact,
  type FileArtifactStore,
} from '../artifacts/index.js';
import type { DiscoveryTrace } from '../discovery/index.js';
import type { EvidenceRecorder } from '../evidence/index.js';
import type { Logger } from '../logging/logger.js';
import {
  DEFAULT_POLICY,
  summarizePolicy,
  type PolicyEngine,
  type PolicySummary,
} from '../policy/index.js';
import { ReplayEngine, type ReplayResult } from '../replay/index.js';
import type { ComputerSurface, SurfaceTimeouts } from '../surfaces/index.js';

import type { CompilationRequest } from './CompilationRequest.js';
import type {
  CompilationFailure,
  CompilationResult,
  CompilationStage,
} from './CompilationResult.js';
import { compileDraft, CompilationProblem } from './TraceCompiler.js';

/**
 * Compile, validate, replay, then save.
 *
 * The order is the whole design. A capability is not accepted because the compiler
 * produced one; it is accepted because the artifact it produced was validated like any
 * file read off a disk and then actually executed against the live application by the real
 * replay engine, through the real policy engine, and worked. Anything that fails on the
 * way returns a rejection and writes nothing.
 *
 * The alternative arrangement, save and then verify and maybe delete, was rejected: it
 * puts an unproven capability in the store for a window during which something could
 * invoke it, and it leaves a broken one behind whenever the delete is the thing that fails.
 *
 * This class knows about replay and knows nothing about Playwright or any model. It is
 * handed a surface it cannot identify, which is what lets the same compiler verify a
 * capability against whatever surface a deployment uses.
 */

/**
 * Opens an evidence recorder for a verification replay of one capability.
 *
 * The caller supplies it because the caller owns where evidence lives and how a run id is
 * chosen. The compiler starts and completes the record around the replay, so the run is
 * finalized whichever way it turns out.
 */
export type VerificationEvidence = (capability: CapabilityArtifact) => Promise<EvidenceRecorder>;

export interface ArtifactCompilerOptions {
  /** Where a verification replay drives the application. */
  readonly surface: ComputerSurface;
  /** The safety boundary. Verification is a real run and is held to the real rules. */
  readonly policy: PolicyEngine;
  readonly store: FileArtifactStore;
  readonly logger: Logger;
  /**
   * Opens the record for the verification replay.
   *
   * A factory rather than a recorder, because a run's manifest names the capability it
   * ran and the capability does not exist until compilation has finished. Verification is
   * its own run with its own id, deliberately separate from the discovery run: they are
   * two different things that happened, and a reader following the chain needs to see
   * both.
   */
  readonly evidence?: VerificationEvidence;
  readonly timeouts?: SurfaceTimeouts;
  /** What the verification run records as the policy in force. */
  readonly policySummary?: PolicySummary;
  /** Injected in tests so a generated artifact is comparable. */
  readonly now?: () => Date;
  /** Injected in tests so the verification run id is predictable. */
  readonly verificationRunId?: string;
}

export class ArtifactCompiler {
  private readonly options: ArtifactCompilerOptions;
  private readonly now: () => Date;

  constructor(options: ArtifactCompilerOptions) {
    this.options = options;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Turns one successful discovery run into a saved, verified capability.
   *
   * Never throws for a compilation that could not be completed. A trace that cannot be
   * normalized, an artifact that will not validate, and a workflow that will not replay are
   * all answers the caller has to report, not exceptions it has to guess at.
   */
  async compile(trace: DiscoveryTrace, request: CompilationRequest): Promise<CompilationResult> {
    const logger = this.options.logger.child({
      capabilityId: request.id,
      discoveryRunId: trace.runId,
    });

    let draft: ReturnType<typeof compileDraft>;
    try {
      draft = compileDraft(trace, request, { now: this.now });
    } catch (error) {
      if (error instanceof CompilationProblem) {
        return this.reject(trace, error.stage, codeFor(error.stage), error.message);
      }
      throw error;
    }

    let capability: CapabilityArtifact;
    try {
      // The compiler's own output goes through the same door a file from disk goes
      // through. Trusting it because we built it is exactly how an invalid artifact gets
      // written by the one component nobody validates.
      capability = parseCapabilityArtifact(draft.draft);
    } catch (error) {
      if (error instanceof ArtifactValidationError) {
        return {
          status: 'rejected',
          stage: 'validation',
          code: 'ARTIFACT_VALIDATION_FAILED',
          message: `The compiled artifact is not valid: ${describeIssues(error)}`,
          sourceDiscoveryRunId: trace.runId,
          issues: error.issues,
        };
      }
      throw error;
    }

    logger.info('Capability Compiled', {
      steps: capability.steps.length,
      inputs: capability.inputs.map((input) => input.name),
      outputs: capability.outputs.map((output) => output.name),
      skippedActions: draft.skippedActions,
    });

    const existing = await this.conflict(capability.id, request, trace.runId);
    if (existing !== undefined) {
      return existing;
    }

    const verification = await this.verify(capability, trace);
    if (verification.result.status !== 'success') {
      return {
        status: 'rejected',
        stage: 'verification',
        code: 'VERIFICATION_REPLAY_FAILED',
        message: `The compiled capability did not replay: ${describeReplay(verification.result)}`,
        sourceDiscoveryRunId: trace.runId,
        verificationReplayRunId: verification.runId,
        capability,
      };
    }

    const unfaithful = unfaithfulOutputs(verification.result.outputs, trace.outputs);
    if (unfaithful.length > 0) {
      return {
        status: 'rejected',
        stage: 'verification',
        code: 'VERIFICATION_REPLAY_FAILED',
        message: `The compiled capability replayed but did not read what the discovery run read for: ${unfaithful.join(', ')}. The extract step resolves to a different part of the page, so the capability would answer the wrong question.`,
        sourceDiscoveryRunId: trace.runId,
        verificationReplayRunId: verification.runId,
        capability,
      };
    }

    let artifactPath: string;
    try {
      artifactPath = await this.options.store.save(capability);
    } catch (error) {
      return {
        status: 'rejected',
        stage: 'persistence',
        code: 'PERSISTENCE_FAILED',
        message: `The verified capability could not be written: ${describeError(error)}`,
        sourceDiscoveryRunId: trace.runId,
        verificationReplayRunId: verification.runId,
        capability,
      };
    }

    logger.info('Capability Saved', { artifactPath, verificationReplayRunId: verification.runId });

    return {
      status: 'compiled',
      capability,
      artifactPath,
      sourceDiscoveryRunId: trace.runId,
      verificationReplayRunId: verification.runId,
      skippedActions: draft.skippedActions,
    };
  }

  /**
   * Replays the compiled capability with the values discovery used.
   *
   * The real engine, the real policy, and the real surface. A verification path that ran
   * something easier would prove that the easier thing works, and the whole question this
   * phase answers is whether the artifact replays the way production replay will run it.
   */
  private async verify(
    capability: CapabilityArtifact,
    trace: DiscoveryTrace,
  ): Promise<{ result: ReplayResult; runId: string }> {
    const inputs: Record<string, string> = {};
    for (const input of trace.inputs) {
      inputs[input.name] = input.value;
    }

    const evidence = await this.options.evidence?.(capability);
    await evidence?.start({
      runId: evidence.runId,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      capabilityName: capability.name,
      // Names only. A verification replay uses the values discovery used, and those are
      // exactly the values that must not be written down.
      inputNames: capability.inputs.map((input) => input.name),
      policy: this.options.policySummary ?? EMPTY_POLICY_SUMMARY,
    });

    // One identifier for the run and its evidence directory. Two would mean correlating
    // them by timestamp, which is exactly what a run id exists to avoid.
    const replayId = this.options.verificationRunId ?? evidence?.runId;

    const engine = new ReplayEngine({
      surface: this.options.surface,
      logger: this.options.logger,
      policy: this.options.policy,
      ...(evidence !== undefined && { evidence }),
      ...(this.options.timeouts !== undefined && { timeouts: this.options.timeouts }),
      ...(replayId !== undefined && { replayId }),
    });

    const result = await engine.run(capability, inputs);

    // Finalized whichever way the replay went, so a rejected capability still leaves a
    // run directory that says why it was rejected.
    await evidence?.complete({
      status: result.status,
      durationMs: result.durationMs,
      completedSteps: result.completedSteps.length,
      recoveries: result.recoveries.length,
    });

    return { result, runId: result.replayId };
  }

  /**
   * Refuses to replace a capability that already exists unless asked to.
   *
   * Silently overwriting is how a capability somebody depends on becomes a capability that
   * merely compiled today. The store writes by id, so the check has to happen before the
   * save rather than inside it.
   */
  private async conflict(
    id: string,
    request: CompilationRequest,
    discoveryRunId: string,
  ): Promise<CompilationFailure | undefined> {
    if (request.overwrite === true) {
      return undefined;
    }

    try {
      await this.options.store.load(id);
    } catch (error) {
      if (error instanceof CapabilityNotFoundError) {
        return undefined;
      }
      // An existing file that will not parse is still an existing file. Overwriting it
      // without being asked would destroy the evidence of whatever is wrong with it.
      return {
        status: 'rejected',
        stage: 'persistence',
        code: 'PERSISTENCE_FAILED',
        message: `A capability already exists at "${id}" and could not be read: ${describeError(error)}. Pass an explicit overwrite to replace it.`,
        sourceDiscoveryRunId: discoveryRunId,
      };
    }

    return {
      status: 'rejected',
      stage: 'persistence',
      code: 'PERSISTENCE_FAILED',
      message: `A capability named "${id}" already exists. Pass an explicit overwrite to replace it, or compile under a different name.`,
      sourceDiscoveryRunId: discoveryRunId,
    };
  }

  private reject(
    trace: DiscoveryTrace,
    stage: CompilationStage,
    code: CompilationFailure['code'],
    message: string,
  ): CompilationFailure {
    return {
      status: 'rejected',
      stage,
      code,
      message,
      sourceDiscoveryRunId: trace.runId,
    };
  }
}

/**
 * What a run records when the caller named no policy summary.
 *
 * The deny-by-default policy, which is the honest thing to write down when nobody said
 * otherwise: a manifest claiming permissions the run may not have had would be worse than
 * one that understates them.
 */
const EMPTY_POLICY_SUMMARY: PolicySummary = summarizePolicy(DEFAULT_POLICY);

function codeFor(stage: 'normalization' | 'parameterization'): CompilationFailure['code'] {
  if (stage === 'normalization') {
    return 'TRACE_NORMALIZATION_FAILED';
  }
  return 'PARAMETERIZATION_FAILED';
}

/**
 * Output names whose replayed value is not the one the discovery run reported.
 *
 * A replay that succeeds proves the workflow ran, and nothing more. An extract step can
 * resolve, return text, and satisfy every condition while reading the wrong element,
 * which produces a capability that works perfectly and answers the wrong question. The
 * run already checked its own reported values against what the application was showing,
 * so those are the reference.
 *
 * Compared on the same relaxed form discovery used, so a difference in currency symbols
 * or separators is not treated as a different value. Only names are returned: the values
 * are the thing that must not be repeated into a message.
 */
function unfaithfulOutputs(
  replayed: Readonly<Record<string, unknown>>,
  reported: Readonly<Record<string, string>>,
): string[] {
  const mismatched: string[] = [];
  for (const [name, expected] of Object.entries(reported)) {
    const actual = replayed[name];
    if (typeof actual !== 'string') {
      continue;
    }
    if (relaxed(actual) !== relaxed(expected)) {
      mismatched.push(name);
    }
  }
  return mismatched;
}

function relaxed(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

function describeIssues(error: ArtifactValidationError): string {
  return error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

/** How a replay outcome reads in a rejection. Never carries an invocation value. */
function describeReplay(result: ReplayResult): string {
  if (result.status === 'businessOutcome') {
    return `the application answered with the declared outcome ${result.code}`;
  }
  if (result.status === 'failure') {
    return `${result.code} (${result.message})`;
  }
  return 'the replay did not succeed';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.split('\n')[0] ?? '';
  }
  return 'unknown failure';
}
