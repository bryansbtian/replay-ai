import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import { FileArtifactStore } from '../artifacts/index.js';
import { ArtifactCompiler, type CompilationResult } from '../compilation/index.js';
import { loadConfig, type AppConfig } from '../config/index.js';
import {
  DEFAULT_LOOP_LIMITS,
  DiscoveryEngine,
  describeAction,
  type DiscoveryInput,
  type DiscoveryResult,
  type DiscoverySuccess,
  type DiscoveryTraceEntry,
} from '../discovery/index.js';
import { ReplayAiError } from '../errors.js';
import { FileEvidenceRecorder } from '../evidence/index.js';
import { createLogger, type Logger } from '../logging/logger.js';
import { StaticPolicyEngine, summarizePolicy } from '../policy/index.js';
import type { ComputerSurface } from '../surfaces/index.js';
import { launchPlaywrightSession, PlaywrightSurface } from '../surfaces/playwright/index.js';

import { createLlmClient } from './llmClient.js';

/**
 * The `discover` command: work out how a goal is achieved in a live application.
 *
 * A composition root, like the replay command, and the reason the engine can stay
 * ignorant of both Playwright and the model provider: this is where a surface and a
 * client are chosen and handed over. Everything above the `ComputerSurface` and
 * `LLMClient` contracts is unaware of either choice.
 *
 * What it prints is deliberately not the run. A `DiscoveryTrace` holds the values the run
 * typed into the application, because Phase 8 needs them in order to work out what should
 * become a capability input, so the trace stays in memory and this command prints a step
 * view built from `describeAction`, which cannot carry one.
 */

const USAGE = `Usage:
  replay-ai discover --goal "<what to achieve>" --target <url> [options]

Options:
  --goal <text>        What the run should achieve, in plain language. Required.
  --target <url>       Where the application starts. Required.
  --name <text>        What to call the application in the prompt. Defaults to its host.
  --input name=value   A value the run should use, repeatable. Becomes a capability input.
  --max-steps <n>      Model decisions the run may carry out.
  --timeout <ms>       Wall-clock ceiling for the whole run.
  --headed             Run the browser with a visible window.

Compilation (a successful run becomes a reusable capability):
  --capability-name <text>         Title Case name. Supplying it turns compilation on.
  --capability-description <text>  What the capability does, for a reviewer or an agent.
  --capability-id <slug>           File name in the capabilities directory. Derived otherwise.
  --overwrite                      Replace a capability that already exists under that id.
`;

/** A CLI argument problem, reported the same way every other typed failure is. */
export class DiscoverCommandError extends ReplayAiError {
  constructor(message: string) {
    super(message, 'DISCOVER_COMMAND_INVALID');
  }
}

interface DiscoverArguments {
  readonly goal: string;
  readonly target: string;
  readonly name?: string;
  readonly inputs: readonly DiscoveryInput[];
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly headless: boolean;
  /** Present when the run should be compiled into a capability afterwards. */
  readonly capability?: CapabilityArguments;
}

interface CapabilityArguments {
  readonly name: string;
  readonly description: string;
  readonly id: string;
  readonly overwrite: boolean;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new DiscoverCommandError(`${flag} requires a value.\n\n${USAGE}`);
  }
  return value;
}

function requireCount(argv: readonly string[], index: number, flag: string): number {
  const raw = requireValue(argv, index, flag);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new DiscoverCommandError(`${flag} must be a whole number greater than zero.`);
  }
  return value;
}

/** Lower-case kebab-case, so a capability name can become a file name. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseDiscoverArguments(argv: readonly string[]): DiscoverArguments {
  const inputs: DiscoveryInput[] = [];
  let goal: string | undefined;
  let target: string | undefined;
  let name: string | undefined;
  let capabilityName: string | undefined;
  let capabilityDescription: string | undefined;
  let capabilityId: string | undefined;
  let overwrite = false;
  let maxSteps: number | undefined;
  let timeoutMs: number | undefined;
  let headless = true;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--goal':
        index += 1;
        goal = requireValue(argv, index, '--goal');
        break;
      case '--target':
        index += 1;
        target = requireValue(argv, index, '--target');
        break;
      case '--name':
        index += 1;
        name = requireValue(argv, index, '--name');
        break;
      case '--max-steps':
        index += 1;
        maxSteps = requireCount(argv, index, '--max-steps');
        break;
      case '--timeout':
        index += 1;
        timeoutMs = requireCount(argv, index, '--timeout');
        break;
      case '--input': {
        index += 1;
        const pair = requireValue(argv, index, '--input');
        const separator = pair.indexOf('=');
        if (separator <= 0) {
          throw new DiscoverCommandError(`--input expects name=value, received "${pair}".`);
        }
        inputs.push({ name: pair.slice(0, separator), value: pair.slice(separator + 1) });
        break;
      }
      case '--capability-name':
        index += 1;
        capabilityName = requireValue(argv, index, '--capability-name');
        break;
      case '--capability-description':
        index += 1;
        capabilityDescription = requireValue(argv, index, '--capability-description');
        break;
      case '--capability-id':
        index += 1;
        capabilityId = requireValue(argv, index, '--capability-id');
        break;
      case '--overwrite':
        overwrite = true;
        break;
      case '--headed':
        headless = false;
        break;
      default:
        throw new DiscoverCommandError(`Unknown option: ${String(flag)}\n\n${USAGE}`);
    }
  }

  if (goal === undefined || goal.trim() === '') {
    throw new DiscoverCommandError(`--goal is required.\n\n${USAGE}`);
  }
  if (target === undefined) {
    throw new DiscoverCommandError(`--target is required.\n\n${USAGE}`);
  }

  const duplicate = inputs.find((input, at) => {
    return inputs.findIndex((other) => other.name === input.name) !== at;
  });
  if (duplicate !== undefined) {
    throw new DiscoverCommandError(`--input "${duplicate.name}" was supplied more than once.`);
  }

  return {
    goal: goal.trim(),
    target,
    headless,
    inputs,
    ...(name !== undefined && { name }),
    ...(maxSteps !== undefined && { maxSteps }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(capabilityName !== undefined && {
      capability: capabilityArgumentsFor(
        capabilityName,
        capabilityDescription,
        capabilityId,
        overwrite,
        goal,
      ),
    }),
  };
}

/**
 * The capability options, with the parts a caller did not spell out.
 *
 * The id is derived from the name so the common invocation is one flag, and the
 * description falls back to the goal, which is a true statement of what the capability
 * does and is better than refusing to compile until somebody writes prose.
 */
function capabilityArgumentsFor(
  name: string,
  description: string | undefined,
  id: string | undefined,
  overwrite: boolean,
  goal: string,
): CapabilityArguments {
  const derived = id ?? slugify(name);
  if (derived === '') {
    throw new DiscoverCommandError(
      `--capability-name "${name}" does not produce a usable id. Pass --capability-id explicitly.`,
    );
  }
  return {
    name,
    id: derived,
    description: description ?? `Discovered workflow for the goal: ${goal}`,
    overwrite,
  };
}

/**
 * Names the application for the prompt.
 *
 * The host is a better default than the whole URL: it is what a person would call the
 * application, and a query string is exactly the part of a URL that carries a reference
 * nobody wants restated in a prompt.
 */
function applicationName(args: DiscoverArguments): string {
  if (args.name !== undefined) {
    return args.name;
  }
  try {
    return new URL(args.target).host;
  } catch {
    throw new DiscoverCommandError(`--target must be an absolute URL.`);
  }
}

/**
 * What the command did: the run, and the compilation when one was asked for.
 *
 * Two fields rather than one merged result, because they are two separate things that
 * happened and either can succeed while the other does not. A run can discover a workflow
 * that then fails to compile, and that is a useful thing to be told precisely.
 */
export interface DiscoverCommandResult {
  readonly discovery: DiscoveryResult;
  readonly compilation?: CompilationResult;
}

export interface DiscoverCommandDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * One step as it is printed.
 *
 * Built from `describeAction`, which renders a control's description and never a value,
 * so this view is safe to print and to paste into a ticket while the trace it came from
 * is not.
 */
interface PrintedStep {
  readonly step: number;
  readonly decision: string;
  readonly summary: string;
  readonly action: string;
  readonly policy: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly url: string;
}

function toPrintedStep(entry: DiscoveryTraceEntry): PrintedStep {
  const base = {
    step: entry.step,
    decision: entry.decisionType,
    summary: entry.summary,
    action: describeAction(entry.action),
    policy: entry.policy,
    durationMs: entry.outcome.durationMs,
    url: entry.stateAfter.url,
  };
  if (entry.outcome.ok) {
    return { ...base, outcome: 'succeeded' };
  }
  return { ...base, outcome: `failed (${entry.outcome.code ?? 'unknown'})` };
}

/** The result, reduced to what is safe to print. Never the trace itself. */
function toPrintedResult(result: DiscoveryResult): Record<string, unknown> {
  const base = {
    status: result.status,
    runId: result.runId,
    goal: result.goal,
    target: result.target,
    stepCount: result.stepCount,
    durationMs: result.durationMs,
    steps: result.trace.entries.map(toPrintedStep),
  };

  if (result.status === 'success') {
    return { ...base, summary: result.summary, outputs: result.outputs };
  }
  if (result.status === 'escalation') {
    return { ...base, source: result.source, reason: result.reason };
  }
  return { ...base, kind: result.kind, code: result.code, message: result.message };
}

function describeStatus(result: DiscoveryResult): string {
  if (result.status === 'success') {
    return 'Goal Completed';
  }
  if (result.status === 'escalation') {
    return `Escalation Required (${result.source})`;
  }
  if (result.kind === 'policy') {
    return `Blocked By Policy (${result.code})`;
  }
  return `Stopped (${result.code})`;
}

/** The evidence path, relative to the working directory when that reads better. */
function describePath(path: string): string {
  const local = relative(process.cwd(), path);
  if (local.startsWith('..')) {
    return path;
  }
  return local;
}

function announceStart(args: DiscoverArguments, model: string): string {
  return [
    '',
    'Discovery Started',
    '',
    `  Goal:   ${args.goal}`,
    `  Target: ${args.target}`,
    `  Model:  ${model}`,
    '',
  ].join('\n');
}

function summarize(result: DiscoveryResult, evidencePath: string, model: string): string {
  const lines = [
    '',
    'Discovery Completed',
    '',
    `  Run ID:   ${result.runId}`,
    `  Status:   ${describeStatus(result)}`,
    `  Model:    ${model}`,
    `  Steps:    ${result.stepCount}`,
    `  Evidence: ${evidencePath}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Runs one discovery and prints its structured result.
 *
 * Run events go to stderr and the result to stdout, so `discover ... | jq` reads a single
 * JSON document. Neither stream carries a credential, a fill value, or anything the
 * provider wrote beyond the bounded summary the decision schema already accepted.
 */
export async function runDiscoverCommand(
  argv: readonly string[],
  deps: DiscoverCommandDeps,
): Promise<DiscoverCommandResult> {
  const args = parseDiscoverArguments(argv);
  const name = applicationName(args);
  const config = loadConfig(deps.env);

  const logger = createLogger({
    level: config.logLevel,
    write: (line) => deps.stderr(`${line}\n`),
  });

  const runId = randomUUID();
  const evidence = new FileEvidenceRecorder({ evidenceDir: config.evidenceDir, runId });
  await evidence.start({
    kind: 'discovery',
    runId,
    goal: args.goal,
    target: args.target,
    policy: summarizePolicy(config.policy),
  });

  const llm = createLlmClient(config);
  deps.stderr(announceStart(args, config.llm.model));
  const session = await launchPlaywrightSession({ headless: args.headless });

  let result: DiscoveryResult;
  let compilation: CompilationResult | undefined;
  try {
    const surface = new PlaywrightSurface({
      page: session.page,
      logger,
      timeouts: config.surfaceTimeouts,
    });
    const engine = new DiscoveryEngine({
      surface,
      llm,
      policy: new StaticPolicyEngine(config.policy),
      evidence,
      logger,
      timeouts: config.surfaceTimeouts,
      runId,
      limits: limitsFor(config, args),
    });
    result = await engine.discover({
      goal: args.goal,
      target: { name, entryPoint: args.target },
      inputs: args.inputs,
    });

    // Compiled inside the same session, because verification replay needs a surface and
    // the one that is already open is the same kind the run used. It is still a separate
    // run with its own id and its own evidence directory.
    if (result.status === 'success' && args.capability !== undefined) {
      compilation = await compileDiscovered(result, args.capability, config, surface, logger);
    }
  } finally {
    await session.close();
  }

  await evidence.complete({
    status: outcomeStatus(result),
    ...outcomeDetail(result),
    durationMs: result.durationMs,
    completedSteps: result.stepCount,
    // Discovery has no recovery concept: a failed action is fed back to the model as the
    // next turn's information rather than retried by a plan.
    recoveries: 0,
  });

  const printed = toPrintedResult(result);
  if (compilation !== undefined) {
    printed['compilation'] = toPrintedCompilation(compilation);
  }

  deps.stdout(`${JSON.stringify(printed, null, 2)}\n`);
  deps.stderr(summarize(result, describePath(evidence.directory), config.llm.model));
  if (compilation !== undefined) {
    deps.stderr(summarizeCompilation(compilation));
  }
  for (const warning of evidence.warnings) {
    deps.stderr(`Evidence Warning: ${warning}\n`);
  }
  return { discovery: result, ...(compilation !== undefined && { compilation }) };
}

/** The compilation outcome, reduced to what is safe to print. Never the artifact body. */
function toPrintedCompilation(compilation: CompilationResult): Record<string, unknown> {
  if (compilation.status === 'compiled') {
    return {
      status: compilation.status,
      capabilityId: compilation.capability.id,
      artifactPath: compilation.artifactPath,
      sourceDiscoveryRunId: compilation.sourceDiscoveryRunId,
      verificationReplayRunId: compilation.verificationReplayRunId,
      inputs: compilation.capability.inputs.map((input) => input.name),
      outputs: compilation.capability.outputs.map((output) => output.name),
      steps: compilation.capability.steps.map((step) => step.id),
      skippedActions: compilation.skippedActions,
    };
  }
  return {
    status: compilation.status,
    stage: compilation.stage,
    code: compilation.code,
    message: compilation.message,
    sourceDiscoveryRunId: compilation.sourceDiscoveryRunId,
    ...(compilation.verificationReplayRunId !== undefined && {
      verificationReplayRunId: compilation.verificationReplayRunId,
    }),
  };
}

function summarizeCompilation(compilation: CompilationResult): string {
  if (compilation.status === 'compiled') {
    return [
      '',
      'Capability Saved',
      '',
      `  Capability:  ${compilation.capability.id}`,
      `  Artifact:    ${describePath(compilation.artifactPath)}`,
      `  Verified By: ${compilation.verificationReplayRunId}`,
      '',
    ].join('\n');
  }
  return [
    '',
    'Capability Rejected',
    '',
    `  Stage:  ${compilation.stage}`,
    `  Code:   ${compilation.code}`,
    `  Reason: ${compilation.message}`,
    '',
    '  Nothing was saved.',
    '',
  ].join('\n');
}

/**
 * Compiles a successful run into a verified capability.
 *
 * A composition root again: the compiler is handed a store, a policy, the same kind of
 * surface, and a way to open evidence for the verification replay. It chooses none of
 * those itself, which is what keeps it free of both Playwright and any model.
 */
async function compileDiscovered(
  result: DiscoverySuccess,
  capability: CapabilityArguments,
  config: AppConfig,
  surface: ComputerSurface,
  logger: Logger,
): Promise<CompilationResult> {
  const compiler = new ArtifactCompiler({
    surface,
    policy: new StaticPolicyEngine(config.policy),
    store: new FileArtifactStore({ directory: config.capabilitiesDir }),
    logger,
    timeouts: config.surfaceTimeouts,
    policySummary: summarizePolicy(config.policy),
    evidence: async (artifact) => {
      // A verification replay is its own run with its own id, so the chain a reviewer
      // follows is discovery run, then capability, then this.
      const runId = randomUUID();
      logger.info('Verification Replay Starting', { runId, capabilityId: artifact.id });
      return Promise.resolve(new FileEvidenceRecorder({ evidenceDir: config.evidenceDir, runId }));
    },
  });

  return await compiler.compile(result.trace, {
    id: capability.id,
    name: capability.name,
    description: capability.description,
    overwrite: capability.overwrite,
  });
}

/** Configuration first, then an explicit override for this one run. */
function limitsFor(config: AppConfig, args: DiscoverArguments): typeof DEFAULT_LOOP_LIMITS {
  return {
    ...DEFAULT_LOOP_LIMITS,
    maxSteps: args.maxSteps ?? config.discovery.maxSteps,
    timeoutMs: args.timeoutMs ?? config.discovery.timeoutMs,
  };
}

function outcomeStatus(result: DiscoveryResult): 'success' | 'failure' | 'escalation' {
  if (result.status === 'success') {
    return 'success';
  }
  if (result.status === 'escalation') {
    return 'escalation';
  }
  return 'failure';
}

function outcomeDetail(result: DiscoveryResult): Record<string, string | string[]> {
  if (result.status === 'success') {
    return { outputNames: Object.keys(result.outputs) };
  }
  if (result.status === 'escalation') {
    return { failureKind: result.source };
  }
  return { code: result.code, failureKind: result.kind };
}
