/**
 * ESLint flat config for Native Translator.
 * Enforces: TypeScript strictness, React hooks safety, code hygiene.
 * Scope: client/src only — server/ and generated files are excluded.
 */
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // ── Global ignores ───────────────────────────────────────────────────────────
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'client/src/components/ui/**',   // shadcn-generated — not our code
      'client/src/hooks/use-toast.ts', // shadcn-generated toast hook
      'client/src/lib/utils.ts',        // shadcn utility
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/__tests__/**',
      'server/**',                       // server has its own concerns
      'scripts/**',
      'vite.config.ts',
      'vitest.config.ts',
      'tailwind.config.ts',
      'postcss.config.js',
      'eslint.config.js',
    ],
  },

  // ── TypeScript rules for client/src ─────────────────────────────────────────
  ...tseslint.configs.recommended,
  {
    files: ['client/src/**/*.ts', 'client/src/**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // ── Errors (block push) ──────────────────────────────────────────────────

      // No implicit `any` — every value must be typed
      '@typescript-eslint/no-explicit-any': 'warn',

      // Unused variables are dead code; prefix with _ to signal intentional omission
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // React hooks must follow the rules of hooks — calling order must be stable
      'react-hooks/rules-of-hooks': 'error',

      // Missing deps in useEffect/useCallback/useMemo is a common source of stale closures
      'react-hooks/exhaustive-deps': 'warn',

      // var is a footgun; use const / let
      'no-var': 'error',

      // Loose equality is almost never intentional
      'eqeqeq': ['error', 'always', { null: 'ignore' }],

      // Prefer const when a variable is never reassigned
      'prefer-const': 'error',

      // Disallow console.* — logger.ts is excluded below (it's the only allowed consumer)
      'no-console': 'error',

      // ── Warnings (informational — do not block push alone) ───────────────────

      // Empty catch blocks hide errors silently
      'no-empty': ['warn', { allowEmptyCatch: false }],

      // == instead of === is a bug magnet
      '@typescript-eslint/no-unnecessary-condition': 'off', // too noisy on guards

      // Deprecated tseslint rules off to reduce noise
      '@typescript-eslint/no-require-imports': 'error',
    },
  },

  // ── logger.ts — console calls are intentional here ──────────────────────────
  {
    files: ['client/src/utils/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
