import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Same shape as `apps/api/eslint.config.mjs`, minus the Nest-specific carve-outs — this
 * package has no decorators and no constructor injection.
 *
 * It exists because `pnpm -r lint` silently skips a package with no `lint` script, so a
 * new package without this file is new code that is never linted, and nothing says so.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
