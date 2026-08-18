import type { OutputDefinition, ValueType } from '../artifacts/index.js';

import type { OutputValue, ReplayFailureCode } from './ReplayResult.js';

/**
 * Turns what the surface read off the screen into the capability's declared outputs.
 *
 * A surface extracts text, and an artifact may declare an output as a number or a
 * boolean, so exactly one conversion sits here. It is intentionally the smallest one
 * that lets Phase 3's typed outputs work at all: a canonical numeric literal, or the
 * words true and false. There is no currency parsing, no thousands separator, no
 * locale, and no natural-language interpretation, because every one of those is a guess
 * and a guess inside replay is a decision replay is not allowed to make.
 *
 * A screen that shows "$5,234.17" therefore fails here rather than being silently
 * reinterpreted. Repairing that is an artifact change (extract the field that holds the
 * raw value) or a future Phase 3 format declaration, not an inference.
 *
 * Only declared outputs are collected, and every declared output must be produced, so
 * the returned record is exactly the contract the artifact published.
 */

/** `innerText` carries the layout's whitespace, which is never part of the value. */
function normalize(text: string): string {
  return text.trim();
}

const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/;

const MAX_OBSERVED_CHARS = 120;

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_OBSERVED_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_OBSERVED_CHARS)}...`;
}

function convert(text: string, type: ValueType): OutputValue | undefined {
  const value = normalize(text);

  if (type === 'string') {
    return value;
  }
  if (type === 'number') {
    if (!NUMERIC_LITERAL.test(value)) {
      return undefined;
    }
    return Number(value);
  }
  const lowered = value.toLowerCase();
  if (lowered === 'true') {
    return true;
  }
  if (lowered === 'false') {
    return false;
  }
  return undefined;
}

/** Why an extracted value could not become an output. */
export interface OutputProblem {
  readonly code: ReplayFailureCode;
  readonly message: string;
  readonly expected: string;
  readonly observed: string;
}

export type RecordOutcome =
  { readonly ok: true } | { readonly ok: false; readonly problem: OutputProblem };

export type CollectOutcome =
  | { readonly ok: true; readonly outputs: Readonly<Record<string, OutputValue>> }
  | { readonly ok: false; readonly problem: OutputProblem };

export class OutputCollector {
  private readonly declared: ReadonlyMap<string, OutputDefinition>;
  private readonly collected = new Map<string, OutputValue>();

  constructor(outputs: readonly OutputDefinition[]) {
    this.declared = new Map(outputs.map((output) => [output.name, output]));
  }

  /**
   * Assigns one extracted text to a declared output, converting it to the declared type.
   *
   * Conversion happens here rather than at the end of the run so that a value the
   * capability cannot use is attributed to the step that read it.
   */
  record(name: string, text: string): RecordOutcome {
    const definition = this.declared.get(name);
    if (definition === undefined) {
      // Phase 3 validation already rejects an artifact whose extract step names an
      // undeclared output, so this is a guard against a hand-built artifact object
      // rather than something a stored file can reach.
      return {
        ok: false,
        problem: {
          code: 'REPLAY_OUTPUT_UNDECLARED',
          message: `Step assigns to "${name}", which this capability does not declare as an output`,
          expected: 'An Output Declared By The Capability',
          observed: `Assignment To "${name}"`,
        },
      };
    }

    const value = convert(text, definition.type);
    if (value === undefined) {
      return {
        ok: false,
        problem: {
          code: 'REPLAY_OUTPUT_TYPE_MISMATCH',
          message: `Output "${name}" could not be read as a ${definition.type}`,
          expected: `A ${definition.type} Value For "${name}"`,
          observed: summarize(text),
        },
      };
    }

    this.collected.set(name, value);
    return { ok: true };
  }

  /** The complete output record, or the first output the run never produced. */
  collect(): CollectOutcome {
    const outputs: Record<string, OutputValue> = {};

    for (const [name, definition] of this.declared) {
      const value = this.collected.get(name);
      if (value === undefined) {
        return {
          ok: false,
          problem: {
            code: 'REPLAY_OUTPUT_MISSING',
            message: `Declared output "${name}" was never produced`,
            expected: `A ${definition.type} Value For "${name}"`,
            observed: 'No Value',
          },
        };
      }
      outputs[name] = value;
    }

    return { ok: true, outputs };
  }
}
