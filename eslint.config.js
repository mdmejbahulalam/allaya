import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Packages that touch the operating system. The renderer must never import them (security boundary). */
const SYSTEM_PACKAGES = [
  '@allaya/database',
  '@allaya/security',
  '@allaya/computer',
  '@allaya/filesystem',
  '@allaya/browser',
  '@allaya/applications',
  '@allaya/tools',
  '@allaya/agent',
  '@allaya/automation',
  '@allaya/memory',
  '@allaya/ai',
  '@allaya/voice',
];

const NODE_BUILTINS = [
  'fs',
  'fs/promises',
  'path',
  'os',
  'child_process',
  'crypto',
  'net',
  'http',
  'https',
  'stream',
  'worker_threads',
  'vm',
  'electron',
  'better-sqlite3',
  'playwright-core',
  'playwright',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/coverage/**',
      'packages/database/migrations/**',
      'playwright-report/**',
      'test-results/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // `unknown` payloads from IPC/JSON are validated with zod before use; these rules add noise, not safety.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  // Plain JS/config files are not part of any TS project.
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  // Renderer: React rules + hard boundary — no Node, Electron, or system-level packages.
  {
    files: ['apps/desktop/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...NODE_BUILTINS.flatMap((name) => [name, `node:${name}`]).map((name) => ({
              name,
              message: 'The renderer is sandboxed. Ask the main process through window.allaya.',
            })),
            ...SYSTEM_PACKAGES.map((name) => ({
              name,
              message: 'System-level package: not allowed in the renderer. Use typed IPC instead.',
            })),
          ],
          patterns: [
            {
              group: ['**/main/**', '**/preload/**'],
              message: 'Renderer must not import main/preload code.',
            },
          ],
        },
      ],
    },
  },
  // Domain packages: independent of UI, Electron and the desktop app.
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'Domain packages must not depend on Electron.' },
            { name: 'react', message: 'Domain packages must not depend on the UI.' },
            { name: 'react-dom', message: 'Domain packages must not depend on the UI.' },
          ],
          patterns: [{ group: ['**/apps/**'], message: 'Packages must not import from apps.' }],
        },
      ],
    },
  },
  // Only the logging sinks and CLI scripts may write to the console.
  {
    files: ['packages/shared/src/logger.ts', 'scripts/**', 'apps/desktop/main/logging.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
