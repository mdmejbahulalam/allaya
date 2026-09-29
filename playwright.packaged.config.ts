import { defineConfig } from '@playwright/test';

/** Checks the package that would actually ship. Not part of the normal run: it needs a packaged build (see the spec). */
export default defineConfig({
  testDir: 'tests/packaged',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results-packaged',
});
