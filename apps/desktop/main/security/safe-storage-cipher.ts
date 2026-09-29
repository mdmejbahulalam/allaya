import { safeStorage } from 'electron';
import type { Cipher } from '@allaya/security';

/**
 * OS-backed encryption for API keys: DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux.
 * On Linux, Electron silently falls back to a hard-coded key ("basic_text") when no keyring exists — that is
 * obfuscation, not protection, so it is treated as unavailable and saving keys is refused.
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
