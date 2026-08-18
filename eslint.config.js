import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

const PLAYWRIGHT_ONLY_IN_ADAPTER = {
  group: ['playwright', 'playwright/*', '@playwright/*', 'playwright-core'],
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
    // Architectural boundary: replay must execute saved capabilities without an LLM
    // in the decision loop, so it may never reach into the llm layer or a model SDK.
    // Repeats the Playwright rule because a later block replaces the earlier one.
    files: ['src/replay/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/llm', '**/llm/**', '@anthropic-ai/*'],
              message: 'replay/ must not depend on llm/: replay runs without an LLM in the loop.',
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
