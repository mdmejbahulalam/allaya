import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Resolve every `@allaya/<pkg>` to its TypeScript source so tests never need a build step. */
const alias: Record<string, string> = Object.fromEntries(
  readdirSync(new URL('./packages', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [`@allaya/${entry.name}`, `${root}packages/${entry.name}/src/index.ts`]),
);

export default defineConfig({
  resolve: {
    alias: {
      ...alias,
      '@main': `${root}apps/desktop/main`,
      '@renderer': `${root}apps/desktop/renderer/src`,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'tests/unit/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            'tests/security/**/*.test.ts',
          ],
          exclude: ['tests/unit/renderer/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/unit/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/setup/renderer.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/desktop/main/**'],
      reporter: ['text-summary', 'html'],
    },
  },
});
