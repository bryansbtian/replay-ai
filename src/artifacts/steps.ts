import { z } from 'zod';

import { TARGET_ROLES, type SurfaceCondition, type Target } from '../surfaces/index.js';

import { parameterNameSchema, stepIdSchema } from './identifiers.js';

/**
 * The workflow vocabulary a capability records: where a value comes from, which control
 * a step acts on, what state a condition asserts, and the ordered steps themselves.
 *
 * Every object is declared with `z.strictObject`, so an unknown key is an error rather
 * than something Zod quietly strips. That is a typo guard, and it is also the reason a
 * stored artifact cannot carry unmodelled data such as a model transcript or a raw form
 * value: there is no field for it, and adding one fails validation.
 */

/**
 * Zod represents an omitted optional property as present with the value `undefined`,
 * which `exactOptionalPropertyTypes` refuses to assign to the surface locator types.
 * Dropping absent keys makes a parsed locator exactly a Phase 2 `LocatorStrategy`, and
 * keeps serialized artifacts free of keys that carry no information.
 */
type WithoutUndefined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

function withoutAbsentKeys<T extends object>(value: T): WithoutUndefined<T> {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested === undefined) {
      continue;
    }
    result[key] = nested;
  }
  return result as WithoutUndefined<T>;
}

const MAX_TEXT_LENGTH = 200;

const matchText = z
  .string()
  .min(1, 'must not be empty')
  .max(MAX_TEXT_LENGTH, `must be at most ${MAX_TEXT_LENGTH} characters`);

/**
 * The Phase 2 locator model, expressed as a schema rather than a second representation.
 * `locatorStrategySchema` parses to the surface's own `LocatorStrategy`, which is what
 * lets a replay hand a stored target straight to a `ComputerSurface` with no conversion
 * layer in between and no chance of the two drifting apart.
 */
export const locatorStrategySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('role'),
      role: z.enum(TARGET_ROLES),
      name: matchText.optional(),
      exact: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal('label'),
      text: matchText,
      exact: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal('placeholder'),
      text: matchText,
      exact: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal('attribute'),
      attribute: z.string().min(1, 'must not be empty').max(MAX_TEXT_LENGTH),
      value: z.string().max(MAX_TEXT_LENGTH),
    }),
    z.strictObject({
      kind: z.literal('text'),
      text: matchText,
      exact: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal('css'),
      selector: z.string().min(1, 'must not be empty').max(MAX_TEXT_LENGTH),
    }),
  ])
  .transform(withoutAbsentKeys);

/**
 * A control described by every way we know to find it, in the order a resolver must try
 * them. The stored order is the recorded order: nothing re-sorts it later, which is what
 * makes resolution during replay the same computation it was during discovery.
 */
export const targetSchema = z.strictObject({
  /** Human-readable name for logs and error messages. Never a value a user typed. */
  description: matchText,
  strategies: z
    .array(locatorStrategySchema)
    .min(1, 'a target must carry at least one locator strategy'),
});

/**
 * One value-source model for every step that needs a value, rather than one field for
 * literals and another for parameters. `literal` is baked into the artifact; `input`
 * names a declared capability input and is supplied per invocation, which is what keeps
 * caller-specific data out of the stored file.
 *
 * Structured on purpose: a `{{ template }}` string would need a parser, would fail late,
 * and could not be checked against the declared inputs without one. A reference is data,
 * so validation can prove it points at something that exists.
 */
export const capabilityValueSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('literal'),
    /** Empty is allowed: clearing a field is a legitimate step. */
    value: z.string().max(MAX_TEXT_LENGTH),
  }),
  z.strictObject({
    source: z.literal('input'),
    name: parameterNameSchema,
  }),
]);

const MAX_URL_PATTERN_LENGTH = 200;

function isCompilableRegExp(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded and compiled at parse time so that a broken pattern is an artifact defect
 * found during review, not an exception thrown in the middle of a replay.
 */
const urlPatternSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(MAX_URL_PATTERN_LENGTH, `must be at most ${MAX_URL_PATTERN_LENGTH} characters`)
  .refine(isCompilableRegExp, { error: 'must be a valid regular expression' });

/**
 * The assertion that a workflow actually reached a state, instead of assuming an action
 * worked because it did not throw.
 *
 * One checkpoint model serves four jobs: the capability's success condition, a wait
 * step's condition, a checkpoint step's assertion, and a business outcome's condition.
 * They are the same question ("does the surface show this state?") so they share one
 * schema rather than three near-identical ones.
 */
export const checkpointSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('targetVisible'), target: targetSchema }),
  z.strictObject({
    type: z.literal('targetContainsText'),
    target: targetSchema,
    text: matchText,
  }),
  z.strictObject({ type: z.literal('textVisible'), text: matchText }),
  z.strictObject({ type: z.literal('urlMatches'), pattern: urlPatternSchema }),
]);

/**
 * What a step does to the application, as the artifact author understands it.
 *
 * This is a description, never a permission. The policy engine stays external and
 * authoritative: an artifact declaring `safe` grants itself nothing, and a policy is
 * free to refuse a step that claims to be harmless.
 */
export const RISK_LEVELS = ['safe', 'risky', 'irreversible'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

const riskSchema = z.enum(RISK_LEVELS).default('safe');

const MAX_STEP_TIMEOUT_MS = 120_000;
const MAX_STEP_ATTEMPTS = 3;

/**
 * Per-step overrides, both optional, for the two cases where a sane default is provably
 * wrong for one step: a screen that legitimately takes longer than the surface budget
 * (a report that renders on demand), and a control that is known to need a second
 * attempt. Replay owns the defaults; the artifact only says where a step differs.
 *
 * Deliberately not a backoff framework. Attempts are capped low, and a step that cannot
 * succeed in a few tries is a workflow that has changed, which is an escalation rather
 * than something to retry harder.
 */
const executionPolicySchema = z.strictObject({
  timeoutMs: z
    .int()
    .positive('must be greater than zero')
    .max(MAX_STEP_TIMEOUT_MS, `must be at most ${MAX_STEP_TIMEOUT_MS} milliseconds`)
    .optional(),
  retry: z
    .strictObject({
      maxAttempts: z
        .int()
        .min(1, 'must be at least one attempt')
        .max(MAX_STEP_ATTEMPTS, `must be at most ${MAX_STEP_ATTEMPTS} attempts`),
    })
    .optional(),
});

/**
 * Split so that a serialized step reads identity first and overrides last, with the
 * fields that describe the action in between.
 */
const stepIdentity = { id: stepIdSchema };
const stepOverrides = { execution: executionPolicySchema.optional() };

/**
 * The ordered actions. A discriminated union rather than an action name plus a bag of
 * data: a `fill` carries a value and a `click` does not, so each shape states exactly
 * the fields its action needs, and neither the compiler nor the validator has to guess
 * which combination is meaningful.
 *
 * `risk` appears only on the three steps that can change the application. Reading and
 * asserting cannot, so giving them a risk field would invite a meaningless declaration.
 */
export const capabilityStepSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({
      ...stepIdentity,
      type: z.literal('navigate'),
      /**
       * A literal absolute location. Assembling a URL from an invocation input is
       * deferred: no workflow needs it yet, and a caller-supplied destination is a
       * policy question (where may this capability go?) that Phase 5 answers. When it
       * arrives it reuses `capabilityValueSchema`, not a template language.
       */
      url: z.url('must be an absolute URL'),
      risk: riskSchema,
      ...stepOverrides,
    }),
    z.strictObject({
      ...stepIdentity,
      type: z.literal('click'),
      target: targetSchema,
      risk: riskSchema,
      ...stepOverrides,
    }),
    z.strictObject({
      ...stepIdentity,
      type: z.literal('fill'),
      target: targetSchema,
      value: capabilityValueSchema,
      risk: riskSchema,
      ...stepOverrides,
    }),
    z.strictObject({
      ...stepIdentity,
      type: z.literal('extract'),
      target: targetSchema,
      /**
       * Names a declared capability output. Extraction reads text; the surface also
       * models `value` and `attribute`, and adding an optional kind later is additive
       * rather than a schema change.
       */
      output: parameterNameSchema,
      ...stepOverrides,
    }),
    z.strictObject({
      ...stepIdentity,
      type: z.literal('wait'),
      /** State-based only. There is no sleep step: a clock is not a synchronization. */
      condition: checkpointSchema,
      ...stepOverrides,
    }),
    z.strictObject({
      ...stepIdentity,
      type: z.literal('checkpoint'),
      /**
       * Verification rather than synchronization. A wait that times out means the state
       * never arrived; a checkpoint that fails means the workflow went somewhere else.
       */
      condition: checkpointSchema,
      ...stepOverrides,
    }),
  ],
  {
    error:
      'must be one of the supported step types: navigate, click, fill, extract, wait, checkpoint',
  },
);

export type CapabilityValue = z.infer<typeof capabilityValueSchema>;
/** The `input` arm of a capability value: the parameter reference. */
export type ParameterReference = Extract<CapabilityValue, { source: 'input' }>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type CheckpointType = Checkpoint['type'];
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type CapabilityStep = z.infer<typeof capabilityStepSchema>;
export type CapabilityStepType = CapabilityStep['type'];

/**
 * The step vocabulary as a value, so that a policy can allowlist action types without
 * restating them. The assertion below is what keeps the list honest: adding a step to
 * the union without adding it here stops compiling, so there is one source of truth
 * rather than two lists that drift.
 */
export const CAPABILITY_STEP_TYPES = [
  'navigate',
  'click',
  'fill',
  'extract',
  'wait',
  'checkpoint',
] as const satisfies readonly CapabilityStepType[];

type UncoveredStepType = Exclude<CapabilityStepType, (typeof CAPABILITY_STEP_TYPES)[number]>;

/** Reads as "no step type is missing from the list above". */
type AssertEveryStepTypeListed<T extends never> = T;

export type _StepTypesAreComplete = AssertEveryStepTypeListed<UncoveredStepType>;

/**
 * A parsed target is the Phase 2 surface target, and the constraint below is the proof:
 * if the schema and the surface model ever drifted apart this would stop compiling. It
 * is what lets a later replay hand a stored target straight to a `ComputerSurface`
 * without a conversion layer, and it keeps a competing control representation out of
 * the artifact package. Callers use the surface's `Target`; this alias exists to be
 * checked, not to be imported.
 */
type SurfaceTarget<T extends Target> = T;

export type ParsedTarget = SurfaceTarget<z.infer<typeof targetSchema>>;

/**
 * The same constraint for checkpoints: a parsed checkpoint is a Phase 2
 * `SurfaceCondition`, so a replay hands a stored condition straight to a surface. Both
 * sides describe one question ("does the surface show this state?"), and this alias is
 * what stops them from answering it differently.
 */
type SurfaceStateCondition<C extends SurfaceCondition> = C;

export type ParsedCheckpoint = SurfaceStateCondition<z.infer<typeof checkpointSchema>>;
