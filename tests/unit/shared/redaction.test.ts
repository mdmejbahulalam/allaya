import { describe, expect, it } from 'vitest';
import { REDACTED, maskSecret, redact, redactString } from '@allaya/shared';

describe('redaction', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({
      provider: 'anthropic',
      apiKey: 'sk-ant-api03-abcdefghijklmnop',
      nested: { password: 'hunter2', note: 'hello', Authorization: 'Bearer abcdefghijklmnop' },
      list: [{ token: 't' }],
    });
    expect(out).toEqual({
      provider: 'anthropic',
      apiKey: REDACTED,
      nested: { password: REDACTED, note: 'hello', Authorization: REDACTED },
      list: [{ token: REDACTED }],
    });
  });

  it('redacts credential-looking values even under innocuous keys', () => {
    expect(redactString('key is sk-ant-api03-abcdefghijklmnop ok')).not.toContain(
      'abcdefghijklmnop',
    );
    expect(redactString('AIzaSyA-1234567890abcdefghijklmnop')).toBe(REDACTED);
    expect(redactString('https://x.test/v1?key=SECRETVALUE&a=1')).toBe(
      `https://x.test/v1?key=${REDACTED}&a=1`,
    );
    expect(redactString('Authorization: Bearer abcdefghijklmnopqrstuv')).toContain(REDACTED);
  });

  it('never mutates its input and survives cycles', () => {
    const input: Record<string, unknown> = { apiKey: 'sk-ant-api03-abcdefghijklmnop' };
    input.self = input;
    const out: Record<string, unknown> = redact(input);
    expect(input.apiKey).toBe('sk-ant-api03-abcdefghijklmnop');
    expect(out.apiKey).toBe(REDACTED);
    expect(out.self).toBe('[Circular]');
  });

  it('masks secrets without revealing the middle', () => {
    expect(maskSecret('sk-ant-api03-abcdefghijklmnop')).toBe('sk-…mnop');
    expect(maskSecret('short')).toBe('••••••••');
  });
});
