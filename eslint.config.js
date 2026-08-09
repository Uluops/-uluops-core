import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Test files: relax no-explicit-any (mock-heavy code legitimately uses any)
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Scripts/examples: relax rules (partial configs, unused imports from interactive use)
    files: ['scripts/**/*.mts', 'examples/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // Plain-JS dev scripts: lint WITHOUT type information.
    //
    // tsconfig.json sets include: ['src/**/*'] and leaves allowJs off, so a .mjs file is
    // never part of the TS program — even though tsconfig.eslint.json widens include to
    // scripts/**/*. The typed parser then fails with "file was not found in any of the
    // provided project(s)", which is a config gap, not a code defect, and it fails the
    // lint gate in prepublishOnly rather than at author time.
    //
    // Disabling `project` here rather than adding allowJs keeps the build surface
    // unchanged: allowJs would pull JS into the emitted program for a script that never
    // ships (see package.json `files`). Nothing is lost — tseslint.configs.recommended
    // carries no type-aware rules, so `project` was only ever supplying type information
    // these files' rules do not consult.
    // Only `project` is disabled — the RULES stay on. Turning them off as well (copying
    // the .mts scripts block above) would leave .mjs files matching a config with no
    // enabled rules, i.e. lint that cannot fail, which is worse than the error it replaced.
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      parserOptions: { project: false },
    },
  },
  {
    ignores: ['dist/', 'coverage/', 'vitest.config.ts'],
  },
);
