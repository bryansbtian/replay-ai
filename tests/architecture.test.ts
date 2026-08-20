import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards the dependency rules the design rests on. ESLint enforces them while editing;
 * these tests make the build fail even if the lint config drifts.
 *
 * 1. Replay executes a saved capability without a model in the decision loop, so nothing
 *    under src/replay may reach the llm layer, the discovery loop, or a model SDK. It
 *    may not reach the browser library either: replay drives a ComputerSurface.
 * 2. Playwright is an implementation detail of one surface adapter, so nothing outside
 *    src/surfaces/playwright may import it. That is what lets a second surface be added
 *    without rewriting anything above the ComputerSurface contract.
 * 3. A capability artifact is the contract between discovery and replay, so the artifact
 *    package may depend on neither, nor on a model SDK. Its only allowed dependencies
 *    are the surface-neutral target model and the shared error base.
 * 4. The safety boundary and the evidence recorder sit below everything that executes
 *    anything, so neither may reach the llm layer, the discovery loop, a model SDK, or
 *    the replay engine. That is what lets the discovery loop of a later phase be held to
 *    the same boundary rather than growing a second, weaker one.
 */

const PLAYWRIGHT_PATTERN = /^(playwright|playwright-core|@playwright\/)/;

const PLAYWRIGHT_ADAPTER_DIR = join('src', 'surfaces', 'playwright');

const IMPORT_PATTERN = /(?:from|import)\s+['"]([^'"]+)['"]/g;

const FORBIDDEN_IN_ARTIFACTS = /(^|\/)(llm|discovery|replay)(\/|$)|^@anthropic-ai\//;

const FORBIDDEN_IN_REPLAY = /(^|\/)(llm|discovery)(\/|$)|^@anthropic-ai\//;

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
  it('keeps replay free of any dependency on the llm layer or on discovery', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(join('src', 'replay'))) {
      for (const specifier of importsOf(file)) {
        if (FORBIDDEN_IN_REPLAY.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps every recovery path free of a model, which is what makes recovery deterministic', () => {
    // Phase 5 added the only code in the system that reacts to a failure by doing
    // something. If an LLM fallback were ever going to appear, it would appear here.
    const recoveryPaths = [
      join('src', 'replay', 'RecoveryPlanner.ts'),
      join('src', 'replay', 'classification.ts'),
      join('src', 'replay', 'ReplayEngine.ts'),
    ];

    const violations: string[] = [];
    for (const file of recoveryPaths) {
      for (const specifier of importsOf(file)) {
        if (FORBIDDEN_IN_REPLAY.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
      const source = readFileSync(file, 'utf8');
      if (/anthropic|claude|\bllm\b/i.test(source)) {
        violations.push(`${file} mentions a model provider`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the safety boundary and the evidence recorder below everything that executes', () => {
    const violations: string[] = [];
    for (const directory of ['policy', 'evidence']) {
      for (const file of sourceFiles(join('src', directory))) {
        for (const specifier of importsOf(file)) {
          if (FORBIDDEN_IN_REPLAY.test(specifier) || PLAYWRIGHT_PATTERN.test(specifier)) {
            violations.push(`${file} imports ${specifier}`);
          }
          if (/(^|\/)replay(\/|$)/.test(specifier)) {
            violations.push(`${file} imports ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps replay off Playwright, so it drives whatever surface it is handed', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(join('src', 'replay'))) {
      for (const specifier of importsOf(file)) {
        if (PLAYWRIGHT_PATTERN.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('lets the policy engine decide without touching anything', () => {
    // A guardrail that reads a file or a network at decision time is a guardrail that can
    // fail open. Everything it needs is handed to it.
    const specifiers = sourceFiles(join('src', 'policy')).flatMap(importsOf);

    expect(specifiers.filter((specifier) => specifier.startsWith('node:'))).toEqual([]);
  });

  it('lets replay reach the application only through the surface contract', () => {
    const specifiers = sourceFiles(join('src', 'replay')).flatMap(importsOf);
    const surfaceImports = new Set(
      specifiers.filter((specifier) => specifier.includes('surfaces')),
    );

    // The adapter lives under surfaces/playwright; importing it would be a second way in.
    expect([...surfaceImports]).toEqual(['../surfaces/index.js']);
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

  it('keeps the handoff domain free of the engines that ask it for a person', () => {
    // Control transfer is about who may act, not about what they were doing. A handoff
    // module that imported the replay engine would be one that could only hand over a
    // replay, and the same mechanism serves discovery.
    const violations: string[] = [];
    for (const directory of ['handoff', 'operator']) {
      for (const file of sourceFiles(join('src', directory))) {
        for (const specifier of importsOf(file)) {
          if (/(^|\/)(llm|discovery|replay|compilation)(\/|$)/.test(specifier)) {
            violations.push(`${file} imports ${specifier}`);
          }
          if (PLAYWRIGHT_PATTERN.test(specifier) || specifier.startsWith('@anthropic-ai/')) {
            violations.push(`${file} imports ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('lets replay ask for a person through one interface rather than through the handoff domain', () => {
    // The seam is `execution/intervention`, which is two methods. Replay importing the
    // session registry or the operator server would couple the executor to how a person is
    // reached, and a scheduled run has nobody to reach.
    const violations: string[] = [];
    for (const file of sourceFiles(join('src', 'replay'))) {
      for (const specifier of importsOf(file)) {
        if (/(^|\/)(handoff|operator)(\/|$)/.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps compilation deterministic, with no model anywhere in it', () => {
    // The project's claim is that a model discovers a workflow once and deterministic code
    // executes it forever after. A compiler that called a model would put one back in the
    // path between the run and the artifact, and the artifact would stop being reproducible
    // from its inputs.
    const violations: string[] = [];
    for (const file of sourceFiles(join('src', 'compilation'))) {
      for (const specifier of importsOf(file)) {
        if (/(^|\/)llm(\/|$)/.test(specifier) || specifier.startsWith('@anthropic-ai/')) {
          violations.push(`${file} imports ${specifier}`);
        }
        if (PLAYWRIGHT_PATTERN.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('lets compilation reach the application only through the surface contract', () => {
    const specifiers = sourceFiles(join('src', 'compilation')).flatMap(importsOf);
    const surfaceImports = new Set(
      specifiers.filter((specifier) => specifier.includes('surfaces')),
    );

    expect([...surfaceImports]).toEqual(['../surfaces/index.js']);
  });

  it('keeps replay independent of the compiler that produces its artifacts', () => {
    // Replay reads validated artifacts and does not know where one came from. A dependency
    // the other way would make the executor care how a workflow was authored.
    const violations: string[] = [];
    for (const file of sourceFiles(join('src', 'replay'))) {
      for (const specifier of importsOf(file)) {
        if (/(^|\/)compilation(\/|$)/.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps discovery on the generic model boundary rather than on a provider', () => {
    // The whole point of `LLMClient` is that the loop cannot tell which provider answered.
    // A direct import of either implementation would quietly undo that, so the check is on
    // the import graph rather than on anyone remembering the rule.
    const violations: string[] = [];
    for (const file of sourceFiles(join('src', 'discovery'))) {
      for (const specifier of importsOf(file)) {
        if (/(^|\/)llm\/(anthropic|ollama)(\/|$)/.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
        if (specifier.startsWith('@anthropic-ai/')) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('lets discovery reach the application only through the surface contract', () => {
    // Same rule replay is held to. A discovery loop that could reach the adapter would be
    // a loop that only works in a browser, and the surface abstraction would be decoration.
    const specifiers = sourceFiles(join('src', 'discovery')).flatMap(importsOf);
    const surfaceImports = new Set(
      specifiers.filter((specifier) => specifier.includes('surfaces')),
    );

    expect([...surfaceImports]).toEqual(['../surfaces/index.js']);
  });

  it('keeps discovery independent of the replay engine', () => {
    // A discovery trace is not a capability artifact, and Phase 8 is what turns one into
    // the other. Discovery reaching into replay would be that compilation happening by
    // accident, in the wrong phase and with nothing validating the result.
    const violations: string[] = [];
    for (const file of sourceFiles(join('src', 'discovery'))) {
      for (const specifier of importsOf(file)) {
        if (/(^|\/)replay(\/|$)/.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('names no hosted model SDK anywhere in source, which is how the isolation stays real', () => {
    // The strongest form of the isolation claim: a hosted SDK import may not appear at
    // all. The shipped client talks to a local runtime over plain HTTP.
    const violations: string[] = [];
    for (const file of sourceFiles('src')) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('@anthropic-ai/')) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the artifact contract independent of discovery, replay, and any model', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(join('src', 'artifacts'))) {
      for (const specifier of importsOf(file)) {
        if (FORBIDDEN_IN_ARTIFACTS.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('lets the artifact contract reuse the surface target model and nothing else from surfaces', () => {
    const specifiers = sourceFiles(join('src', 'artifacts')).flatMap(importsOf);
    const surfaceImports = specifiers.filter((specifier) => specifier.includes('surfaces'));

    expect(surfaceImports).toEqual(['../surfaces/index.js']);
  });
});
