import { ReplayAiError } from '../errors.js';

/**
 * The artifact package's failures.
 *
 * `ArtifactValidationError` is also the validation boundary: Zod issues are translated
 * into `ArtifactIssue` here and nowhere else, so no other layer has to know which
 * library validated the file, and a future change of validator cannot ripple outwards.
 */

/** One problem with an artifact, addressed by its location in the document. */
export interface ArtifactIssue {
  /** Dotted path such as `steps[2].value.name`. Empty for a whole-document problem. */
  readonly path: string;
  readonly message: string;
}

export interface ArtifactValidationErrorOptions extends ErrorOptions {
  /** Where the artifact came from, such as a file path. Named in the message. */
  readonly source?: string;
}

function describeIssues(issues: readonly ArtifactIssue[]): string {
  const lines = issues.map((issue) => {
    if (issue.path === '') {
      return `  ${issue.message}`;
    }
    return `  ${issue.path}: ${issue.message}`;
  });
  return lines.join('\n');
}

function describeSubject(source: string | undefined): string {
  if (source === undefined) {
    return 'Capability artifact is invalid';
  }
  return `Capability artifact ${source} is invalid`;
}

/** An artifact failed shape or semantic validation. */
export class ArtifactValidationError extends ReplayAiError {
  readonly issues: readonly ArtifactIssue[];

  constructor(issues: readonly ArtifactIssue[], options: ArtifactValidationErrorOptions = {}) {
    super(
      `${describeSubject(options.source)}:\n${describeIssues(issues)}`,
      'ARTIFACT_INVALID',
      options,
    );
    this.issues = issues;
  }
}

/**
 * An id that cannot be turned into a file name. Raised before any path is built, which
 * is what keeps a caller-supplied id from reaching the filesystem at all.
 */
export class InvalidCapabilityIdError extends ReplayAiError {
  readonly capabilityId: string;

  constructor(capabilityId: string, reason: string) {
    super(`Capability id is not usable: ${reason}`, 'ARTIFACT_ID_INVALID');
    this.capabilityId = capabilityId;
  }
}

/** No artifact with that id exists in the store. */
export class CapabilityNotFoundError extends ReplayAiError {
  readonly capabilityId: string;

  constructor(capabilityId: string, directory: string) {
    super(`No capability "${capabilityId}" in ${directory}`, 'ARTIFACT_NOT_FOUND');
    this.capabilityId = capabilityId;
  }
}
