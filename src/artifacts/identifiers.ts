import { z } from 'zod';

/**
 * The identifier rules the artifact contract depends on.
 *
 * They live in one module because two things read them: the schema, which rejects a
 * malformed identifier at parse time, and the artifact store, which turns a capability
 * id into a file name. A store that trusted an arbitrary string would be one bad id
 * away from writing outside its directory, so the rule that makes an id safe is stated
 * once and enforced in both places.
 */

const MAX_IDENTIFIER_LENGTH = 64;

/**
 * Lower-case kebab-case. Chosen for capability and step ids because it reads well in a
 * file name, a URL, and a log line, and because it contains no path separator, no dot,
 * and no character a filesystem treats specially.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A conventional programming identifier. Input and output names are addressed by a
 * calling agent as named arguments and returned values, so they follow the shape of a
 * field name rather than a slug.
 */
const PARAMETER_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

/** Screaming snake case, the usual shape of a machine-readable outcome code. */
const OUTCOME_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export const capabilityIdSchema = z
  .string()
  .max(MAX_IDENTIFIER_LENGTH, `must be at most ${MAX_IDENTIFIER_LENGTH} characters`)
  .regex(SLUG_PATTERN, 'must be lower-case kebab-case, for example "lookup-demo-customer"');

export const stepIdSchema = z
  .string()
  .max(MAX_IDENTIFIER_LENGTH, `must be at most ${MAX_IDENTIFIER_LENGTH} characters`)
  .regex(SLUG_PATTERN, 'must be lower-case kebab-case, for example "enter-customer-reference"');

export const parameterNameSchema = z
  .string()
  .max(MAX_IDENTIFIER_LENGTH, `must be at most ${MAX_IDENTIFIER_LENGTH} characters`)
  .regex(PARAMETER_NAME_PATTERN, 'must be a camelCase name, for example "customerReference"');

export const businessOutcomeCodeSchema = z
  .string()
  .max(MAX_IDENTIFIER_LENGTH, `must be at most ${MAX_IDENTIFIER_LENGTH} characters`)
  .regex(OUTCOME_CODE_PATTERN, 'must be upper snake case, for example "CUSTOMER_NOT_FOUND"');
