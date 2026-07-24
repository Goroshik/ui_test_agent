// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'cypress-tests/**', '*.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      complexity: ['error', 8],
      'max-depth': ['error', 3],
      'max-lines-per-function': ['error', 50],
      'max-params': ['error', 4],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // describe/it blocks are declarative test structure, not algorithmic
    // functions — max-lines-per-function penalizes a describe() wrapping many
    // it() cases even though no individual test or assertion is complex.
    // complexity/max-depth/max-params still apply and catch genuinely
    // convoluted test logic.
    files: ['**/*.test.ts'],
    rules: {
      'max-lines-per-function': 'off',
    },
  },
);
