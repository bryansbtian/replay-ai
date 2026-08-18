/**
 * Durable, sanitized records of what a run did.
 *
 * Depends on the shared redaction rules and on nothing that executes anything, so a
 * recorder can be handed to replay today and to the discovery loop of a later phase
 * without either learning about the other.
 */
export { EvidenceWriteError, InvalidRunIdError } from './errors.js';
export { FileEvidenceRecorder, type FileEvidenceRecorderOptions } from './FileEvidenceRecorder.js';
export {
  NO_EVIDENCE,
  RUN_EVENT_NAMES,
  type DiscoveryStartRecord,
  type EvidenceRecorder,
  type ReplayStartRecord,
  type RunEvent,
  type RunEventName,
  type RunOutcomeRecord,
  type RunStartRecord,
} from './types.js';
