import type { Cipher, CredentialStore, StoredCredential } from '@allaya/security';
import type { ProviderId } from '@allaya/types';

/** Reversible stand-in for OS encryption. Marks ciphertext so tests can prove plaintext never hits storage. */
export class FakeCipher implements Cipher {
  constructor(public available = true) {}
  isAvailable() {
    return this.available;
  }
  encrypt(plain: string) {
    return `enc:${Buffer.from(plain, 'utf8').toString('base64').split('').reverse().join('')}`;
  }
  decrypt(encoded: string) {
    if (!encoded.startsWith('enc:')) throw new Error('bad ciphertext');
    return Buffer.from(encoded.slice(4).split('').reverse().join(''), 'base64').toString('utf8');
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly rows = new Map<ProviderId, StoredCredential>();
  get(id: ProviderId) {
    return this.rows.get(id);
  }
  put(id: ProviderId, encryptedKey: string, maskedHint: string) {
    this.rows.set(id, { encryptedKey, maskedHint });
  }
  delete(id: ProviderId) {
    this.rows.delete(id);
  }
}
