import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import { loadConfig, type AppConfig } from '../config/index.js';
import {
  DEFAULT_LOOP_LIMITS,
  DiscoveryEngine,
  describeAction,
  type DiscoveryResult,
  type DiscoveryTraceEntry,
} from '../discovery/index.js';
import { ReplayAiError } from '../errors.js';
import { FileEvidenceRecorder } from '../evidence/index.js';
import { createLogger } from '../logging/logger.js';
import { StaticPolicyEngine, summarizePolicy } from '../policy/index.js';
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
  --max-steps <n>      Model decisions the run may carry out.
  --timeout <ms>       Wall-clock ceiling for the whole run.
  --headed             Run the browser with a visible window.
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
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly headless: boolean;
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

export function parseDiscoverArguments(argv: readonly string[]): DiscoverArguments {
  let goal: string | undefined;
  let target: string | undefined;
  let name: string | undefined;
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

  return {
    goal: goal.trim(),
    target,
    headless,
    ...(name !== undefined && { name }),
    ...(maxSteps !== undefined && { maxSteps }),
    ...(timeoutMs !== undefined && { timeoutMs }),
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
    steps: result.trace.map(toPrintedStep),
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
): Promise<DiscoveryResult> {
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
  const session = await launchPlaywrightSession({ headless: args.headless });

  let result: DiscoveryResult;
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
    });
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

  deps.stdout(`${JSON.stringify(toPrintedResult(result), null, 2)}\n`);
  deps.stderr(summarize(result, describePath(evidence.directory), config.llm.model));
  for (const warning of evidence.warnings) {
    deps.stderr(`Evidence Warning: ${warning}\n`);
  }
  return result;
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
    return { kind: result.source };
  }
  return { code: result.code, kind: result.kind };
}
