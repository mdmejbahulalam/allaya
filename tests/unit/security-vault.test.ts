import { describe, expect, it } from 'vitest';
import { CredentialVault, checkApiKeyFormat } from '@allaya/security';
import { FakeCipher, MemoryCredentialStore } from '../helpers/cipher';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
const setup = (available = true) => {
  const store = new MemoryCredentialStore();
  return {
    store,
    cipher: new FakeCipher(available),
    vault: new CredentialVault(store, new FakeCipher(available)),
  };
};

describe('API key format checks', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['short', 'too_short'],
    ['x'.repeat(513), 'too_long'],
    ['sk-ant-abc def-ghijkl', 'whitespace'],
    ['sk-ant-abc\ndef-ghijkl', 'control_chars'],
    ['sk-ant-abc\u0000def-ghijkl', 'control_chars'],
  ] as const)('rejects %j (%s)', (input, reason) => {
    expect(checkApiKeyFormat('anthropic', input)).toEqual({ ok: false, reason });
  });

  it('trims surrounding whitespace from a pasted key and only warns on an unusual prefix', () => {
    expect(checkApiKeyFormat('anthropic', `  ${KEY}\n`)).toEqual({ ok: true, key: KEY });
    expect(checkApiKeyFormat('anthropic', 'totally-different-format-1234')).toMatchObject({
      ok: true,
      warning: 'unexpected_prefix',
    });
    expect(checkApiKeyFormat('openrouter', 'sk-or-v1-abcdefghijk')).not.toHaveProperty('warning');
  });
});

describe('CredentialVault', () => {
  it('stores ciphertext only — the plaintext key never reaches storage', () => {
    const { vault, store } = setup();
    vault.set('anthropic', KEY);
    const row = store.get('anthropic')!;
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain('abcdefghijklmnop');
    expect(row.encryptedKey.startsWith('enc:')).toBe(true);
  });

  it('round-trips the key and only ever exposes a masked hint', () => {
    const { vault } = setup();
    const { maskedHint } = vault.set('anthropic', KEY);
    expect(vault.get('anthropic')).toBe(KEY);
    expect(maskedHint).toBe('sk-…wxyz');
    expect(maskedHint).not.toContain('abcdef');
    expect(vault.maskedHint('anthropic')).toBe(maskedHint);
  });

  it('REFUSES to store when OS encryption is unavailable — no plaintext fallback', () => {
    const { vault, store } = setup(false);
    expect(() => vault.set('anthropic', KEY)).toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_STORAGE_UNAVAILABLE' }),
    );
    expect(store.rows.size).toBe(0);
  });

  it('rejects malformed keys with INVALID_INPUT and stores nothing', () => {
    const { vault, store } = setup();
    expect(() => vault.set('openai', 'has a space in it')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(store.rows.size).toBe(0);
  });

  it('a missing key is PROVIDER_NOT_CONFIGURED', () => {
    const { vault } = setup();
    expect(vault.has('google')).toBe(false);
    expect(() => vault.get('google')).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
  });

  it('a key that can no longer be decrypted gives an actionable error, never garbage', () => {
    const { vault, store } = setup();
    store.put('openai', 'not-valid-ciphertext', 'sk-…1234');
    expect(() => vault.get('openai')).toThrowError(
      expect.objectContaining({ code: 'CREDENTIAL_STORAGE_UNAVAILABLE' }),
    );
  });

  it('overwrites and removes keys', () => {
    const { vault } = setup();
    vault.set('anthropic', KEY);
    vault.set('anthropic', 'sk-ant-api03-zzzzzzzzzzzzzzzzzzzz');
    expect(vault.get('anthropic')).toBe('sk-ant-api03-zzzzzzzzzzzzzzzzzzzz');
    vault.remove('anthropic');
    expect(vault.has('anthropic')).toBe(false);
  });

  it('error messages never contain the key', () => {
    const { vault } = setup(false);
    try {
      vault.set('anthropic', KEY);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('abcdefghijklmnop');
      expect(JSON.stringify((error as { details?: unknown }).details ?? {})).not.toContain(
        'abcdefghijklmnop',
      );
    }
  });
});
