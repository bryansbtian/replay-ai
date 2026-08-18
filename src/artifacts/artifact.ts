import { z } from 'zod';

import { capabilityIdSchema, declaredCodeSchema, parameterNameSchema } from './identifiers.js';
import { capabilityStepSchema, checkpointSchema, targetSchema } from './steps.js';

/**
 * The capability artifact: the contract discovery writes and replay reads.
 *
 * Nothing here knows about a model, a prompt, or a browser. An artifact is a plain JSON
 * document describing what a workflow does, which controls it touches, what it needs
 * from a caller, and how to tell that it worked, so it can be reviewed by a person,
 * invoked by an agent, and executed by a replay engine that has no LLM in its loop.
 */

/**
 * The version of the file format, not of the capability. It changes when the shape of
 * an artifact changes in a way an older reader cannot handle, which is what makes a
 * future migration possible: a reader can tell what it is holding before it tries to
 * parse it.
 *
 * This build supports exactly one version. An unknown version fails validation with a
 * message that says so, rather than producing a pile of shape errors.
 */
export const SCHEMA_VERSION = '1';

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

const descriptionSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(MAX_DESCRIPTION_LENGTH, `must be at most ${MAX_DESCRIPTION_LENGTH} characters`);

const shortDescriptionSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(MAX_NAME_LENGTH, `must be at most ${MAX_NAME_LENGTH} characters`);

/**
 * Where the capability applies. Two fields, because two are what a reader and a policy
 * check actually need: which application this was recorded against, and where it starts.
 *
 * Deliberately a nested object rather than two loose fields, so that later specialization
 * (a tenant, a vendor build, a surface kind) is an added key here instead of a redesign
 * of the artifact. None of that is implemented.
 */
const targetApplicationSchema = z.strictObject({
  name: shortDescriptionSchema,
  entryPoint: z.url('must be an absolute URL'),
});

/**
 * The scalar types an invocation can carry. Three, because three is what the steps can
 * currently use. Nested objects, arrays, unions, and dates are absent on purpose: every
 * one of them would need a resolution rule in replay that nothing yet requires, and an
 * unused type in a contract is a promise someone will eventually try to call in.
 */
export const VALUE_TYPES = ['string', 'number', 'boolean'] as const;

export type ValueType = (typeof VALUE_TYPES)[number];

const valueTypeSchema = z.enum(VALUE_TYPES, {
  error: `must be one of ${VALUE_TYPES.join(', ')}`,
});

/**
 * What a caller must supply. Typed so that a replay can reject a bad invocation before
 * it touches the application, and so that an agent reading the artifact knows what to
 * pass without inspecting the steps.
 */
const inputDefinitionSchema = z.strictObject({
  name: parameterNameSchema,
  type: valueTypeSchema,
  required: z.boolean(),
  description: descriptionSchema,
  /**
   * Marks a value that must never reach a log, an evidence file, or an error message.
   * The value itself is never in the artifact; this is the declaration that tells the
   * layers which will handle it to treat it as secret.
   */
  sensitive: z.boolean().default(false),
});

/**
 * What the capability returns. Declared separately from the steps that produce them so
 * that the return shape is readable on its own, and so an extract step can be checked
 * against a promise the capability actually made.
 */
const outputDefinitionSchema = z.strictObject({
  name: parameterNameSchema,
  type: valueTypeSchema,
  description: descriptionSchema,
});

/**
 * What a declared state means for the run that meets it.
 *
 * Most declared states are answers: "no customer matches that reference" is a result the
 * caller asked for, not a broken automation. A few are not. "You do not have permission
 * to view this member" is a state the application is entitled to show and the automation
 * is entitled to recognize, but it is not an answer to the question that was asked, and
 * continuing past it is not something replay may decide to do.
 *
 * The distinction is declared rather than inferred, because only the capability's author
 * knows which of its application's messages are answers. An engine that guessed would be
 * classifying by string matching against page text, which is the one thing a stable code
 * must never be derived from.
 */
export const OUTCOME_DISPOSITIONS = ['businessOutcome', 'failure'] as const;

export type OutcomeDisposition = (typeof OUTCOME_DISPOSITIONS)[number];

/**
 * A state of the business process the capability recognizes on sight.
 *
 * The field is still called `businessOutcomes` because most entries are exactly that,
 * and because it is the one list of declared application states: a second array for the
 * states that happen to stop a run would be the same concept written twice, with two
 * places to look when a code turns up in a result.
 */
const businessOutcomeSchema = z.strictObject({
  code: declaredCodeSchema,
  description: descriptionSchema,
  condition: checkpointSchema,
  disposition: z.enum(OUTCOME_DISPOSITIONS).default('businessOutcome'),
});

/** Recovery attempts are bounded by the same small ceiling that bounds step retries. */
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * A runtime state the capability recognizes as transient, and the one interaction that
 * clears it.
 *
 * This is deliberately not a workflow language. A recovery names a condition, a single
 * control to activate, and how many times the pair may be applied; replay then retries
 * the step that failed. Anything richer would be branching, and branching inside an
 * artifact is where determinism and reviewability both go.
 *
 * Declaring recoveries is what keeps automatic dismissal safe. An engine that dismissed
 * whatever dialog it found would eventually approve something, so only a control this
 * list names is ever activated.
 */
const recoverySchema = z.strictObject({
  code: declaredCodeSchema,
  description: descriptionSchema,
  /** How the state is recognized. The same condition model every checkpoint uses. */
  condition: checkpointSchema,
  action: z.strictObject({
    /**
     * Activate one declared control, then retry the step that failed. One kind, because
     * one kind covers the states a capability can recognize today: an interstitial to
     * acknowledge, and a prompt to re-run a request that did not land.
     */
    type: z.literal('dismiss'),
    target: targetSchema,
  }),
  maxAttempts: z
    .int()
    .min(1, 'must be at least one attempt')
    .max(MAX_RECOVERY_ATTEMPTS, `must be at most ${MAX_RECOVERY_ATTEMPTS} attempts`)
    .default(1),
});

/**
 * Provenance a reviewer needs, and nothing else. There is no free-form bag here: an
 * untyped metadata object is exactly where a prompt, a transcript, or a captured form
 * value would end up.
 */
const metadataSchema = z.strictObject({
  createdAt: z.iso.datetime('must be an ISO 8601 timestamp'),
  updatedAt: z.iso.datetime('must be an ISO 8601 timestamp'),
  tags: z
    .array(
      z
        .string()
        .min(1, 'must not be empty')
        .max(32, 'must be at most 32 characters')
        .regex(/^[a-z0-9-]+$/, 'must be lower-case kebab-case'),
    )
    .default([]),
});

export const capabilityArtifactSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION, `must be "${SCHEMA_VERSION}"`),
  /** Machine identifier, also the file name under the capabilities directory. */
  id: capabilityIdSchema,
  /** Human-facing name, written in Title Case, for example "Lookup Demo Customer". */
  name: shortDescriptionSchema,
  /** What the capability does, for a reviewer and for an agent choosing between them. */
  description: descriptionSchema,
  /**
   * The revision of this capability. Unrelated to `schemaVersion`: it increments when
   * the workflow itself is re-recorded or repaired, for instance after the application
   * moved a button, while the file format stays the same.
   */
  version: z.int().positive('must be a positive integer'),
  application: targetApplicationSchema,
  inputs: z.array(inputDefinitionSchema).default([]),
  outputs: z.array(outputDefinitionSchema).default([]),
  steps: z.array(capabilityStepSchema).min(1, 'a capability must have at least one step'),
  /**
   * Required, and the reason the artifact is worth trusting: without it a replay can
   * only report that no step threw, which is not the same as the workflow having
   * reached the state it was recorded to reach.
   */
  successCondition: checkpointSchema,
  businessOutcomes: z.array(businessOutcomeSchema).default([]),
  /**
   * Runtime states this capability knows how to clear. Empty for a workflow that has
   * never met one, which is the honest default: a recovery nobody has seen fire is a
   * control being clicked for reasons no one can check.
   */
  recoveries: z.array(recoverySchema).default([]),
  metadata: metadataSchema,
});

export type TargetApplication = z.infer<typeof targetApplicationSchema>;
export type InputDefinition = z.infer<typeof inputDefinitionSchema>;
export type OutputDefinition = z.infer<typeof outputDefinitionSchema>;
export type BusinessOutcomeDefinition = z.infer<typeof businessOutcomeSchema>;
export type RecoveryDefinition = z.infer<typeof recoverySchema>;
export type RecoveryAction = RecoveryDefinition['action'];
export type CapabilityMetadata = z.infer<typeof metadataSchema>;
export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
