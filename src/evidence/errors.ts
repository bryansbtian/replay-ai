import { ReplayAiError } from '../errors.js';

/**
 * The manifest could not be written.
 *
 * Thrown rather than swallowed, because a run directory that exists but says nothing
 * about the run is not evidence, and a system that quietly produces one has an
 * observability failure it will not find out about until it needs the record.
 */
export class EvidenceWriteError extends ReplayAiError {
  readonly path: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`Evidence could not be written to ${path}: ${reason}`, 'EVIDENCE_WRITE_FAILED', options);
    this.path = path;
  }
}

/** A run id that cannot safely become a directory name. */
export class InvalidRunIdError extends ReplayAiError {
  constructor(reason: string) {
    super(`Run id is not usable: ${reason}`, 'EVIDENCE_RUN_ID_INVALID');
  }
}
