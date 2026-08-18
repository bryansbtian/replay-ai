import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards the one dependency rule that the design depends on: replay executes a saved
 * capability without a model in the decision loop, so nothing under src/replay may
 * reach the llm layer or a model SDK. ESLint enforces the same rule while editing;
 * this test makes it fail the build even if the lint config drifts.
 */

const IMPORT_PATTERN = /(?:from|import)\s+['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
      continue;
    }
    if (full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function importsOf(file: string): string[] {
  const contents = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of contents.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe('module boundaries', () => {
  it('keeps replay free of any dependency on the llm layer', () => {
    const violations: string[] = [];
    for (const file of sourceFiles('src/replay')) {
      for (const specifier of importsOf(file)) {
        if (/(^|\/)llm(\/|$)/.test(specifier) || specifier.startsWith('@anthropic-ai/')) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
