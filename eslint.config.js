import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

// Matches the browser library itself, and nothing else. A path such as
// `../surfaces/playwright/index.js` is this project's adapter, which a composition root
// is expected to import; a glob would catch that too and say the wrong thing about it.
const PLAYWRIGHT_ONLY_IN_ADAPTER = {
  regex: '^(playwright|playwright-core)(/|$)|^@playwright/',
  message: 'Only src/surfaces/playwright may import Playwright: depend on ComputerSurface instead.',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  // Placed before the project rules on purpose: it switches off stylistic rules that
  // could fight Prettier, and it also switches off `curly`, which this project wants.
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importX,
    },
    rules: {
      // Readability rules required by the project style guide.
      curly: ['error', 'all'],
      'no-ternary': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
      'prefer-const': 'error',

      // Types at module boundaries, no silent any, no unused code.
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Deterministic, readable import order.
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'parent', 'sibling', 'index'],
          alphabetize: { order: 'asc', caseInsensitive: true },
          'newlines-between': 'always',
        },
      ],
      'import-x/no-duplicates': 'error',
    },
  },
  {
    // Architectural boundary: the browser library is an implementation detail of one
    // surface adapter. Everything else depends on the ComputerSurface contract, which is
    // what allows a second surface to be added without touching a recorded workflow.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [PLAYWRIGHT_ONLY_IN_ADAPTER] }],
    },
  },
  {
    files: ['src/surfaces/playwright/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Architectural boundary: a capability artifact is the contract between discovery and
    // replay, so it must stay independent of both, and of any model SDK. That is what
    // keeps a stored artifact readable by a replay engine with no LLM in its loop.
    // Repeats the Playwright rule because a later block replaces the earlier one.
    files: ['src/artifacts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/llm', '**/llm/**', '**/discovery', '**/discovery/**', '@anthropic-ai/*'],
              message:
                'artifacts/ must not depend on llm/ or discovery/: an artifact is model-provider independent.',
            },
            {
              group: ['**/replay', '**/replay/**'],
              message:
                'artifacts/ describes a workflow and must not depend on the engine that executes it.',
            },
            PLAYWRIGHT_ONLY_IN_ADAPTER,
          ],
        },
      ],
    },
  },
  {
    // Architectural boundary: replay must execute saved capabilities without an LLM
    // in the decision loop, so it may never reach into the llm layer, the discovery
    // loop, or a model SDK.
    // Repeats the Playwright rule because a later block replaces the earlier one.
    files: ['src/replay/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/llm',
                '**/llm/**',
                '**/discovery',
                '**/discovery/**',
                '**/compilation',
                '**/compilation/**',
                '**/handoff',
                '**/handoff/**',
                '**/operator',
                '**/operator/**',
                '@anthropic-ai/*',
              ],
              message:
                'replay/ must not depend on llm/, discovery/, compilation/, or handoff/: it asks for a person through execution/intervention, which is one interface.',
            },
            PLAYWRIGHT_ONLY_IN_ADAPTER,
          ],
        },
      ],
    },
  },
  {
    // Architectural boundary: discovery is the one place with a model in its decision
    // loop, and it depends on the generic LLM client rather than on a provider. Naming a
    // provider directory here would put an SDK behind an interface that exists precisely
    // so nothing above it has to know which one is configured. Composition roots under
    // src/cli are what choose an implementation.
    // Repeats the Playwright rule because a later block replaces the earlier one.
    files: ['src/discovery/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/llm/anthropic', '**/llm/anthropic/**', '@anthropic-ai/*'],
              message:
                'discovery/ depends on the generic LLMClient: a provider is chosen by a composition root.',
            },
            {
              group: ['**/llm/ollama', '**/llm/ollama/**'],
              message:
                'discovery/ depends on the generic LLMClient: a provider is chosen by a composition root.',
            },
            {
              group: ['**/replay', '**/replay/**'],
              message:
                'discovery/ must not depend on the deterministic replay engine: a discovery trace is not an artifact.',
            },
            PLAYWRIGHT_ONLY_IN_ADAPTER,
          ],
        },
      ],
    },
  },
  {
    // Architectural boundary: compilation turns a discovery trace into an artifact and
    // verifies it by replaying it. It is deliberately deterministic, so it may not reach a
    // model SDK or the provider clients, and it drives whatever surface it is handed rather
    // than a browser it chose.
    // Repeats the Playwright rule because a later block replaces the earlier one.
    files: ['src/compilation/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/llm', '**/llm/**', '@anthropic-ai/*'],
              message:
                'compilation/ must be deterministic: turning a trace into an artifact never asks a model.',
            },
            PLAYWRIGHT_ONLY_IN_ADAPTER,
          ],
        },
      ],
    },
  },
  {
    // Architectural boundary: the handoff domain owns control transfer and nothing else. It
    // is handed a surface it cannot identify, so it may not reach a browser library, and it
    // must not contain the business logic of either engine that asks it for a person.
    // Repeats the Playwright rule because a later block replaces the earlier one.
    files: ['src/handoff/**/*.ts', 'src/operator/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/llm',
                '**/llm/**',
                '**/discovery',
                '**/discovery/**',
                '**/replay',
                '**/replay/**',
                '**/compilation',
                '**/compilation/**',
                '@anthropic-ai/*',
              ],
              message:
                'handoff/ and operator/ transfer control: they may not depend on the engines that ask them to, nor on a model SDK.',
            },
            PLAYWRIGHT_ONLY_IN_ADAPTER,
          ],
        },
      ],
    },
  },
  {
    // Architectural boundary: the safety guardrail and the run record sit below
    // everything that executes anything, so a future discovery loop is held to the same
    // boundary rather than growing its own. Repeats the Playwright rule because a later
    // block replaces the earlier one.
    files: ['src/policy/**/*.ts', 'src/evidence/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/llm',
                '**/llm/**',
                '**/discovery',
                '**/discovery/**',
                '**/replay',
                '**/replay/**',
                '@anthropic-ai/*',
              ],
              message:
                'policy/ and evidence/ must sit below execution: they may not depend on replay, discovery, or a model SDK.',
            },
            PLAYWRIGHT_ONLY_IN_ADAPTER,
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['*.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
