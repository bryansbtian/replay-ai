import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards the two dependency rules the design rests on. ESLint enforces both while
 * editing; these tests make the build fail even if the lint config drifts.
 *
 * 1. Replay executes a saved capability without a model in the decision loop, so nothing
 *    under src/replay may reach the llm layer or a model SDK.
 * 2. Playwright is an implementation detail of one surface adapter, so nothing outside
 *    src/surfaces/playwright may import it. That is what lets a second surface be added
 *    without rewriting anything above the ComputerSurface contract.
 */

const PLAYWRIGHT_PATTERN = /^(playwright|playwright-core|@playwright\/)/;

const PLAYWRIGHT_ADAPTER_DIR = join('src', 'surfaces', 'playwright');

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

  it('keeps Playwright inside the surface adapter that owns it', () => {
    const violations: string[] = [];
    for (const file of sourceFiles('src')) {
      if (file.startsWith(PLAYWRIGHT_ADAPTER_DIR)) {
        continue;
      }
      for (const specifier of importsOf(file)) {
        if (PLAYWRIGHT_PATTERN.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the surface contract free of browser vocabulary', () => {
    const contract = readFileSync(join('src', 'surfaces', 'ComputerSurface.ts'), 'utf8');
    const types = readFileSync(join('src', 'surfaces', 'types.ts'), 'utf8');

    for (const source of [contract, types]) {
      expect(source).not.toMatch(/\bPage\b|\bLocator\b|\bBrowserContext\b/);
    }
  });
});
