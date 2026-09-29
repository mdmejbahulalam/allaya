import type { Cipher } from '@allaya/security';
import type { ProviderId } from '@allaya/types';

/**
 * Test-only hooks. Every use is behind `if (E2E)`, where `E2E` is a compile-time constant that is `false`
 * in production builds, so this code (and the reversible test cipher) is removed from shipped bundles.
 */
export const E2E: boolean = import.meta.env.MODE === 'e2e';

/** Reversible, NON-secure cipher so E2E can save API keys on a machine with no OS keyring. */
export class InsecureTestCipher implements Cipher {
  isAvailable(): boolean {
    return true;
  }
  encrypt(plain: string): string {
    return `e2e:${Buffer.from(plain, 'utf8').toString('base64')}`;
  }
  decrypt(encoded: string): string {
    return Buffer.from(encoded.replace(/^e2e:/, ''), 'base64').toString('utf8');
  }
}

/** `ALLAYA_E2E_AI_BASE_URLS='{"anthropic":"http://127.0.0.1:1234"}'` points providers at a local fake. */
export function e2eBaseUrls(): Partial<Record<ProviderId, string>> {
  try {
    return JSON.parse(process.env['ALLAYA_E2E_AI_BASE_URLS'] ?? '{}') as Partial<
      Record<ProviderId, string>
    >;
  } catch {
    return {};
  }
}

/**
 * `ALLAYA_E2E_FILES_DIR` gives the known folders (Desktop, Documents…) a sandbox to live in, so tests never touch
 * the real profile. It must be outside the user-data folder, which the file tools refuse to touch.
 */
export const e2eFilesDir = (): string | undefined => process.env['ALLAYA_E2E_FILES_DIR'];

/** In E2E the native folder picker cannot be driven, so it "picks" this folder instead. */
export const e2ePickedFolder = (): string | undefined => process.env['ALLAYA_E2E_PICK_FOLDER'];

/** `ALLAYA_E2E_BROWSER_EXE`: the Chromium to drive in test runs (there is no Edge/Chrome in CI). */
export const e2eBrowserExecutable = (): string | undefined => process.env['ALLAYA_E2E_BROWSER_EXE'];

/**
 * `ALLAYA_E2E_BROWSER_HOSTS='fake.test,other.test'`: public-looking names that reach the local fixture server. Every
 * other name behaves as in production, so the private-network rules can be tested for real.
 */
export function e2eBrowserHosts(): string[] {
  return (process.env['ALLAYA_E2E_BROWSER_HOSTS'] ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}
