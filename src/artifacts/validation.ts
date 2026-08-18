import type { z } from 'zod';

import { capabilityArtifactSchema, SCHEMA_VERSION, type CapabilityArtifact } from './artifact.js';
import { ArtifactValidationError, type ArtifactIssue } from './errors.js';
import { collectSemanticIssues } from './semantics.js';

/**
 * The one way to turn unknown data into a `CapabilityArtifact`.
 *
 * Three checks in a fixed order, because each only makes sense once the previous passed:
 * the file format version, then the shape, then the relationships between the parts. A
 * caller gets a typed artifact or a typed error listing every problem with its location.
 */

/** Renders a Zod path the way a reviewer would point at the JSON: `steps[2].value.name`. */
function formatPath(path: readonly PropertyKey[]): string {
  let rendered = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${segment}]`;
      continue;
    }
    if (rendered === '') {
      rendered += String(segment);
      continue;
    }
    rendered += `.${String(segment)}`;
  }
  return rendered;
}

/** The validation boundary: Zod issues become `ArtifactIssue` here and nowhere else. */
function toArtifactIssues(error: z.ZodError): ArtifactIssue[] {
  return error.issues.map((issue) => {
    return { path: formatPath(issue.path), message: issue.message };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the file format version before anything else.
 *
 * An artifact written against a future schema is one problem, not the fifty shape errors
 * a full parse would report against it, so the version is checked first and the failure
 * says exactly that.
 */
function assertSupportedSchemaVersion(value: unknown, source: string | undefined): void {
  if (!isRecord(value)) {
    throw fail([{ path: '', message: 'a capability artifact must be a JSON object' }], source);
  }

  const schemaVersion = value['schemaVersion'];
  if (schemaVersion === undefined) {
    throw fail(
      [{ path: 'schemaVersion', message: `is required and must be "${SCHEMA_VERSION}"` }],
      source,
    );
  }
  if (schemaVersion === SCHEMA_VERSION) {
    return;
  }
  throw fail(
    [
      {
        path: 'schemaVersion',
        message: `unsupported artifact schema version; this build reads only "${SCHEMA_VERSION}"`,
      },
    ],
    source,
  );
}

function fail(
  issues: readonly ArtifactIssue[],
  source: string | undefined,
): ArtifactValidationError {
  if (source === undefined) {
    return new ArtifactValidationError(issues);
  }
  return new ArtifactValidationError(issues, { source });
}

export interface ParseArtifactOptions {
  /** Where the data came from, such as a file path. Named in a failure message. */
  readonly source?: string;
}

/**
 * Validates unknown data and returns a typed capability artifact.
 *
 * @throws ArtifactValidationError listing every problem found, each with its path.
 */
export function parseCapabilityArtifact(
  value: unknown,
  options: ParseArtifactOptions = {},
): CapabilityArtifact {
  const source = options.source;
  assertSupportedSchemaVersion(value, source);

  const parsed = capabilityArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw fail(toArtifactIssues(parsed.error), source);
  }

  const semanticIssues = collectSemanticIssues(parsed.data);
  if (semanticIssues.length > 0) {
    throw fail(semanticIssues, source);
  }

  return parsed.data;
}
