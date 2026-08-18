import type { CapabilityArtifact } from './artifact.js';
import { ArtifactValidationError } from './errors.js';
import { parseCapabilityArtifact, type ParseArtifactOptions } from './validation.js';

/**
 * JSON in, JSON out, with validation on both sides.
 *
 * Artifacts are reviewed in pull requests, so the written form is indented, ends with a
 * newline, and has a key order that does not depend on how the object was built: writing
 * runs the artifact through the schema first, which rebuilds it in schema order. Two
 * equivalent artifacts therefore produce the same file, and a diff shows what changed in
 * the workflow rather than how the object was assembled.
 */

const INDENT = 2;

/**
 * Renders an artifact as the JSON that belongs on disk.
 *
 * Validating here rather than trusting the caller means a file that exists is a file
 * that parses, which is what a later replay depends on.
 *
 * @throws ArtifactValidationError when the artifact is not valid.
 */
export function serializeCapabilityArtifact(artifact: CapabilityArtifact): string {
  const validated = parseCapabilityArtifact(artifact);
  return `${JSON.stringify(validated, null, INDENT)}\n`;
}

function describeJsonFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'unknown parse failure';
}

/**
 * Parses JSON text into a validated artifact.
 *
 * @throws ArtifactValidationError when the text is not JSON, or is JSON that is not a
 * valid artifact.
 */
export function deserializeCapabilityArtifact(
  json: string,
  options: ParseArtifactOptions = {},
): CapabilityArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    const issue = { path: '', message: `is not valid JSON: ${describeJsonFailure(cause)}` };
    if (options.source === undefined) {
      throw new ArtifactValidationError([issue], { cause });
    }
    throw new ArtifactValidationError([issue], { source: options.source, cause });
  }

  return parseCapabilityArtifact(parsed, options);
}
