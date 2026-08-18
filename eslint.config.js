import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

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
    // Architectural boundary: replay must execute saved capabilities without an LLM
    // in the decision loop, so it may never reach into the llm layer or a model SDK.
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
