import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { CapabilityArtifact } from './artifact.js';
import {
  ArtifactValidationError,
  CapabilityNotFoundError,
  InvalidCapabilityIdError,
} from './errors.js';
import { capabilityIdSchema } from './identifiers.js';
import { deserializeCapabilityArtifact, serializeCapabilityArtifact } from './serialization.js';

/**
 * Capability artifacts as files in a directory, one JSON document per capability.
 *
 * A directory is the whole design. Artifacts are reviewed in pull requests and are a
 * deliverable of this project, so they need to be readable and diffable more than they
 * need a database, and a run is local. Anything a registry would add (search, sharing,
 * concurrent writers) is a problem nothing has yet.
 */

/** Enough to choose a capability without reading the whole file. */
export interface CapabilitySummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
}

export interface FileArtifactStoreOptions {
  /** Directory holding the artifacts, normally `AppConfig.capabilitiesDir`. */
  readonly directory: string;
}

const FILE_EXTENSION = '.json';

export class FileArtifactStore {
  private readonly directory: string;

  constructor(options: FileArtifactStoreOptions) {
    this.directory = resolve(options.directory);
  }

  /**
   * Writes the artifact as `<id>.json`, creating the directory if needed.
   *
   * @returns the path written.
   * @throws ArtifactValidationError when the artifact is not valid, so that an
   * unreadable file is never created.
   */
  async save(artifact: CapabilityArtifact): Promise<string> {
    const json = serializeCapabilityArtifact(artifact);
    const path = this.pathFor(artifact.id);
    await mkdir(this.directory, { recursive: true });
    await writeFile(path, json, 'utf8');
    return path;
  }

  /**
   * Reads one artifact through the full validation path: file, JSON, schema, semantics.
   *
   * @throws CapabilityNotFoundError when no such file exists.
   * @throws InvalidCapabilityIdError when the id could not name a file.
   * @throws ArtifactValidationError when the file is not a valid artifact.
   */
  async load(id: string): Promise<CapabilityArtifact> {
    const path = this.pathFor(id);
    const json = await this.read(path, id);
    const artifact = deserializeCapabilityArtifact(json, { source: path });

    if (artifact.id !== id) {
      // A file whose name and id disagree would be loadable under one id and listed
      // under another, so it is a defect rather than something to resolve silently.
      throw new ArtifactValidationError(
        [{ path: 'id', message: `does not match the file name "${id}${FILE_EXTENSION}"` }],
        { source: path },
      );
    }
    return artifact;
  }

  /**
   * Summarizes every artifact in the directory, ordered by id so that output is stable.
   *
   * Subdirectories are ignored, so a store directory can hold supporting files without
   * them reading as capabilities. A missing directory lists as empty; an unreadable file is an error,
   * because quietly skipping one would hide the capability rather than the problem.
   */
  async list(): Promise<CapabilitySummary[]> {
    const entries = await this.readDirectory();
    const summaries: CapabilitySummary[] = [];

    for (const name of entries) {
      const path = join(this.directory, name);
      const json = await readFile(path, 'utf8');
      const artifact = deserializeCapabilityArtifact(json, { source: path });
      summaries.push({
        id: artifact.id,
        name: artifact.name,
        description: artifact.description,
        version: artifact.version,
      });
    }

    return summaries.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async readDirectory(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(FILE_EXTENSION))
      .map((entry) => entry.name)
      .sort();
  }

  private async read(path: string, id: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        throw new CapabilityNotFoundError(id, this.directory);
      }
      throw error;
    }
  }

  /**
   * Turns an id into a path, refusing anything the schema would refuse.
   *
   * The id rule already excludes separators, dots, and absolute paths, so traversal is
   * impossible by construction; the containment check that follows costs nothing and
   * means a future change to the rule cannot quietly open a way out of the directory.
   */
  private pathFor(id: string): string {
    const parsed = capabilityIdSchema.safeParse(id);
    if (!parsed.success) {
      throw new InvalidCapabilityIdError(
        id,
        'a capability id must be lower-case kebab-case and cannot contain a path',
      );
    }

    const path = resolve(this.directory, `${parsed.data}${FILE_EXTENSION}`);
    if (!path.startsWith(`${this.directory}${sep}`)) {
      throw new InvalidCapabilityIdError(id, 'the resulting path is outside the store directory');
    }
    return path;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
