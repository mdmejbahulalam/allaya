import { describe, expect, it } from 'vitest';
import { checkEndpointUrl, isLoopbackHost, requireEndpointUrl } from '@allaya/ai';

describe('which addresses may receive a key', () => {
  it.each([
    ['http://localhost:11434/v1', 'http://localhost:11434/v1', true],
    ['http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1', true],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1', true],
    ['http://ollama.localhost/v1', 'http://ollama.localhost/v1', true],
    ['https://api.example.com/v1', 'https://api.example.com/v1', false],
    ['  https://api.example.com/openai/v1//  ', 'https://api.example.com/openai/v1', false],
    ['https://192.168.1.20:8443', 'https://192.168.1.20:8443', false],
  ])('accepts %s', (raw, url, local) => {
    expect(checkEndpointUrl(raw)).toEqual({ ok: true, url, local });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['not a url', 'malformed'],
    ['localhost:11434', 'scheme'],
    ['ftp://example.com', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['https://user:secret@api.example.com/v1', 'credentials'],
    ['https://user@api.example.com/v1', 'credentials'],
    ['https://api.example.com/v1?key=abc', 'query'],
    ['https://api.example.com/v1#frag', 'query'],
    ['http://api.example.com/v1', 'insecure_remote'],
    ['http://192.168.1.20:11434/v1', 'insecure_remote'],
    ['http://localhost.evil.example/v1', 'insecure_remote'],
    ['http://127.0.0.1.evil.example/v1', 'insecure_remote'],
    [`https://example.com/${'a'.repeat(300)}`, 'too_long'],
  ])('refuses %s (%s)', (raw, reason) => {
    expect(checkEndpointUrl(raw)).toEqual({ ok: false, reason });
  });

  it('knows the computer’s own addresses, and only those', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]', 'a.localhost'])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['example.com', '10.0.0.1', '128.0.0.1', 'localhost.example.com', '0.0.0.0'])
      expect(isLoopbackHost(host)).toBe(false);
  });

  it('requireEndpointUrl throws an INVALID_INPUT error carrying the reason, not the address', () => {
    expect(requireEndpointUrl('http://localhost:1/v1')).toBe('http://localhost:1/v1');
    try {
      requireEndpointUrl('https://user:pw@x.example');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'credentials' } });
      expect(JSON.stringify(error)).not.toContain('pw');
    }
  });
});
