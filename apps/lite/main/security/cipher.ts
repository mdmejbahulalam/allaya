import { safeStorage } from 'electron';
import type { Cipher } from '@allaya/security';

/**
 * Encryption by the operating system: DPAPI on Windows, Keychain on macOS, the keyring on Linux. On Linux Electron
 * quietly falls back to a fixed key when there is no keyring; that is obfuscation, not protection, so it counts as
 * unavailable and keys are refused rather than stored weakly.
 */
export class SafeStorageCipher implements Cipher {
  isAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux')
      return safeStorage.getSelectedStorageBackend() !== 'basic_text';
    return true;
  }
  encrypt(plain: string): string {
    return safeStorage.encryptString(plain).toString('base64');
  }
  decrypt(encoded: string): string {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  }
}

/** For automated tests only (see `e2e.ts`): reversible and NOT secure, so a machine without a keyring can run them. */
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
