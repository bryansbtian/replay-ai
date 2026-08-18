import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { redactRecord } from '../redaction.js';

import { EvidenceWriteError, InvalidRunIdError } from './errors.js';
import type { EvidenceRecorder, RunEvent, RunOutcomeRecord, RunStartRecord } from './types.js';

/**
 * Run evidence as files in a directory, one directory per run.
 *
 * ```text
 * <evidenceDir>/runs/<runId>/
 *   metadata.json      the manifest, written at the start and rewritten at the end
 *   events.jsonl       one line per event, append-only
 *   screenshots/       richer signal for the failure that ended the run
 * ```
 *
 * A directory is the whole design, for the same reason the artifact store is one: a run
 * record is something a person reads, diffs, and attaches to a ticket. Anything a
 * database would add is a problem this does not have.
 */

/** The id shape `randomUUID` produces, and the only shape allowed to name a directory. */
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Screenshot labels become file names, so they may only contain safe characters. */
const LABEL_PATTERN = /[^a-z0-9]+/gi;

const METADATA_FILE = 'metadata.json';
const EVENTS_FILE = 'events.jsonl';
const SCREENSHOTS_DIR = 'screenshots';
const INDENT = 2;

export interface FileEvidenceRecorderOptions {
  /** Normally `AppConfig.evidenceDir`. Run directories are created beneath it. */
  readonly evidenceDir: string;
  readonly runId: string;
  /** Clock, injected in tests so a manifest is comparable. */
  readonly now?: () => Date;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'unknown write failure';
}

export class FileEvidenceRecorder implements EvidenceRecorder {
  readonly runId: string;
  readonly directory: string;
  readonly capturesScreenshots = true;

  private readonly now: () => Date;
  private readonly collected: string[] = [];
  private started: RunStartRecord | undefined;
  private startedAt = '';
  private screenshotCount = 0;

  constructor(options: FileEvidenceRecorderOptions) {
    this.runId = assertUsableRunId(options.runId);
    this.now = options.now ?? ((): Date => new Date());

    const root = resolve(options.evidenceDir, 'runs');
    const directory = resolve(root, this.runId);
    // The id pattern already excludes separators and dots, so escaping the root is
    // impossible by construction. The check costs nothing and means a future change to
    // the id strategy cannot quietly open a way out.
    if (!directory.startsWith(`${root}${sep}`)) {
      throw new InvalidRunIdError('the resulting path is outside the evidence directory');
    }
    this.directory = directory;
  }

  get warnings(): readonly string[] {
    return this.collected;
  }

  /**
   * Creates the run directory and writes the first manifest.
   *
   * The manifest is written twice, here and at completion, so that a run killed halfway
   * still leaves a directory that says what was running.
   */
  async start(record: RunStartRecord): Promise<void> {
    this.started = record;
    this.startedAt = this.now().toISOString();

    try {
      await mkdir(join(this.directory, SCREENSHOTS_DIR), { recursive: true });
    } catch (error) {
      throw new EvidenceWriteError(this.directory, describeFailure(error), { cause: error });
    }

    await this.writeMetadata({ status: 'running' });
    if (record.kind === 'discovery') {
      await this.recordEvent({
        event: 'discovery_started',
        fields: { goal: record.goal, target: record.target, policy: record.policy },
      });
      return;
    }
    await this.recordEvent({
      event: 'run_started',
      fields: {
        capabilityId: record.capabilityId,
        capabilityVersion: record.capabilityVersion,
        capabilityName: record.capabilityName,
        // Names only. A value can be a credential, and evidence outlives the run.
        inputNames: record.inputNames,
        policy: record.policy,
      },
    });
  }

  /**
   * Appends one event.
   *
   * Never throws. Losing a line of observability is bad; changing what an automation did
   * because a disk was full is worse, and a caller that has to wrap every event in a
   * try block will eventually forget one.
   */
  async recordEvent(event: RunEvent): Promise<void> {
    const line = JSON.stringify({
      timestamp: this.now().toISOString(),
      runId: this.runId,
      event: event.event,
      ...redactRecord(event.fields ?? {}),
    });

    try {
      await appendFile(join(this.directory, EVENTS_FILE), `${line}\n`, 'utf8');
    } catch (error) {
      this.warn(`event "${event.event}" could not be appended: ${describeFailure(error)}`);
    }
  }

  /**
   * Stores one capture under a deterministic name such as `001-wait-timeout.png`.
   *
   * The name is built from a counter and the failure code, never from an invocation
   * value, so a directory listing cannot leak what a run was looking up.
   */
  async saveScreenshot(label: string, data: Uint8Array): Promise<string | undefined> {
    this.screenshotCount += 1;
    const ordinal = String(this.screenshotCount).padStart(3, '0');
    const slug = label.replace(LABEL_PATTERN, '-').replace(/^-|-$/g, '').toLowerCase();
    const name = `${ordinal}-${slug}.png`;

    try {
      await writeFile(join(this.directory, SCREENSHOTS_DIR, name), data);
    } catch (error) {
      this.warn(`screenshot "${name}" could not be written: ${describeFailure(error)}`);
      return undefined;
    }
    await this.recordEvent({ event: 'screenshot_captured', fields: { file: name } });
    return name;
  }

  /** Rewrites the manifest with how the run ended. Throws if it cannot. */
  async complete(outcome: RunOutcomeRecord): Promise<void> {
    await this.recordEvent({
      event: 'run_completed',
      fields: {
        status: outcome.status,
        code: outcome.code,
        kind: outcome.kind,
        durationMs: outcome.durationMs,
      },
    });
    await this.writeMetadata(outcome);
  }

  private warn(message: string): void {
    this.collected.push(message);
  }

  /**
   * Writes the manifest through a temporary file and a rename, so a reader never finds a
   * half-written JSON document. Not a transaction, just the one guarantee that costs a
   * single extra call.
   */
  private async writeMetadata(outcome: RunOutcomeRecord | { status: 'running' }): Promise<void> {
    const record = this.started;
    if (record === undefined) {
      throw new EvidenceWriteError(this.directory, 'the run was completed before it was started');
    }

    const manifest = {
      runId: this.runId,
      ...identityOf(record),
      policy: record.policy,
      startedAt: this.startedAt,
      completedAt: completedAt(outcome, this.now),
      ...outcome,
      warnings: this.collected,
    };

    const path = join(this.directory, METADATA_FILE);
    const temporary = `${path}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, INDENT)}\n`, 'utf8');
      await rename(temporary, path);
    } catch (error) {
      throw new EvidenceWriteError(path, describeFailure(error), { cause: error });
    }
  }
}

/**
 * The part of the manifest that says what was running.
 *
 * Split by kind rather than merged, so a discovery manifest does not carry empty
 * capability fields that a reader would have to interpret.
 */
function identityOf(record: RunStartRecord): Record<string, unknown> {
  if (record.kind === 'discovery') {
    return { kind: 'discovery', goal: record.goal, target: record.target };
  }
  return {
    kind: 'replay',
    capabilityId: record.capabilityId,
    capabilityVersion: record.capabilityVersion,
    capabilityName: record.capabilityName,
    inputNames: record.inputNames,
  };
}

function completedAt(
  outcome: RunOutcomeRecord | { status: 'running' },
  now: () => Date,
): string | undefined {
  if (outcome.status === 'running') {
    return undefined;
  }
  return now().toISOString();
}

function assertUsableRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new InvalidRunIdError('a run id must be a UUID');
  }
  return runId;
}
