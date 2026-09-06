import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'spikes/**',
      'coverage/**',
      '.tokensave/**',
      '.local/**',
      // The golden corpus is *data* — EPIC-096. Its `.ts` files are input to a
      // measurement, not project source, and linting them would make the
      // dataset answerable to this repository's style rules rather than to what
      // it is meant to represent.
      'datasets/golden/corpus/**',
      // EPIC-097's parser fixtures, for the same reason and one more: one of
      // them contains a deliberate syntax error, because a parser harness whose
      // corpus is all well-formed cannot measure error recovery. Linting it
      // would fail permanently, correctly, about a file whose brokenness is the
      // point.
      'datasets/parsing/corpus/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'benchmark/**/*.mjs',
      'tests/fixtures/**/*.mjs',
      'eslint.config.js',
    ],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off', '@typescript-eslint/no-unsafe-member-access': 'off' },
  },
);
