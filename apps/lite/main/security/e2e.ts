/**
 * Test-only hooks. Each use is behind `if (E2E)`, a compile-time constant that is `false` in a normal build, so none
 * of this ships.
 */
export const E2E: boolean = import.meta.env.MODE === 'e2e';

/** `ALLAYA_E2E_AI_BASE_URLS='{"anthropic":"http://127.0.0.1:1234"}'` points a service at a local fake. */
export function e2eBaseUrls(): Record<string, string> {
  try {
    return JSON.parse(process.env['ALLAYA_E2E_AI_BASE_URLS'] ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
