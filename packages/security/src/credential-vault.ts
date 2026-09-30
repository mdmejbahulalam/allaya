import { AllayaError, maskSecret } from '@allaya/shared';
import type { ProviderId } from '@allaya/types';

/** OS-backed encryption (Electron `safeStorage` → DPAPI on Windows). Injected so the vault is testable. */
export interface Cipher {
  /** False when the OS cannot protect secrets (e.g. Linux without a keyring). */
  isAvailable(): boolean;
  /** Returns base64 ciphertext. */
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

export interface StoredCredential {
  encryptedKey: string;
  maskedHint: string;
}

export interface CredentialStore {
  get(providerId: ProviderId): StoredCredential | undefined;
  put(providerId: ProviderId, encryptedKey: string, maskedHint: string): void;
  delete(providerId: ProviderId): void;
}

export interface ApiKeyCheck {
  ok: boolean;
  /** Normalised key (trimmed) when ok. */
  key?: string;
  reason?: 'empty' | 'too_short' | 'too_long' | 'whitespace' | 'control_chars';
  /** Non-blocking hint, e.g. the key doesn't look like the provider's usual format. */
  warning?: 'unexpected_prefix';
}

const EXPECTED_PREFIX: Record<ProviderId, string> = {
  anthropic: 'sk-ant-',
  openai: 'sk-',
  openrouter: 'sk-or-',
  google: 'AIza',
  groq: 'gsk_',
  deepseek: 'sk-',
  xai: 'xai-',
  // These have no fixed format, so any key is accepted without a warning.
  mistral: '',
  together: '',
  ollama: '',
  custom: '',
};

/**
 * Structural checks only — real validity is decided by the provider (connection test). Prefixes are a
 * warning, never a rejection, because providers change key formats.
 */
export function checkApiKeyFormat(providerId: ProviderId, raw: string): ApiKeyCheck {
  const key = raw.trim();
  if (key.length === 0) return { ok: false, reason: 'empty' };
  if (key.length < 8) return { ok: false, reason: 'too_short' };
  if (key.length > 512) return { ok: false, reason: 'too_long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return { ok: false, reason: 'control_chars' };
  if (/\s/.test(key)) return { ok: false, reason: 'whitespace' };
  return {
    ok: true,
    key,
    ...(key.startsWith(EXPECTED_PREFIX[providerId])
      ? {}
      : { warning: 'unexpected_prefix' as const }),
  };
}

/**
 * Stores provider API keys encrypted at rest. Guarantees:
 *  - a key is never persisted in plaintext: if the OS can't encrypt, `set` refuses (no silent fallback)
 *  - `get` is only called by the main process at request time; the renderer only ever sees `maskedHint`
 *  - a key that can no longer be decrypted (profile moved to another machine/user) reads as "not configured"
 *    and surfaces an actionable error, rather than sending garbage to a provider
 */
export class CredentialVault {
  constructor(
    private readonly store: CredentialStore,
    private readonly cipher: Cipher,
  ) {}

  set(
    providerId: ProviderId,
    rawKey: string,
  ): { maskedHint: string; warning?: 'unexpected_prefix' } {
    const check = checkApiKeyFormat(providerId, rawKey);
    if (!check.ok || !check.key) {
      throw new AllayaError('That API key is not in a valid format', {
        code: 'INVALID_INPUT',
        details: { reason: check.reason },
      });
    }
    if (!this.cipher.isAvailable()) {
      throw new AllayaError('Secure credential storage is not available on this system', {
        code: 'CREDENTIAL_STORAGE_UNAVAILABLE',
      });
    }
    const maskedHint = maskSecret(check.key);
    this.store.put(providerId, this.cipher.encrypt(check.key), maskedHint);
    return { maskedHint, ...(check.warning ? { warning: check.warning } : {}) };
  }

  get(providerId: ProviderId): string {
    const stored = this.store.get(providerId);
    if (!stored) {
      throw new AllayaError(`No API key is configured for ${providerId}`, {
        code: 'PROVIDER_NOT_CONFIGURED',
        details: { provider: providerId },
      });
    }
    try {
      return this.cipher.decrypt(stored.encryptedKey);
    } catch (cause) {
      throw new AllayaError('The saved API key could not be decrypted. Please enter it again.', {
        code: 'CREDENTIAL_STORAGE_UNAVAILABLE',
        details: { provider: providerId },
        cause,
      });
    }
  }

  has(providerId: ProviderId): boolean {
    return this.store.get(providerId) !== undefined;
  }

  maskedHint(providerId: ProviderId): string | undefined {
    return this.store.get(providerId)?.maskedHint;
  }

  remove(providerId: ProviderId): void {
    this.store.delete(providerId);
  }
}
