import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NONCE_PLACEHOLDER,
  injectNonce,
  newNonce,
  resolveAppRequest,
} from '@main/security/app-protocol-core';
import { buildCsp } from '@main/security/csp';
import { isTrustedRendererUrl } from '@main/security/window-security';

const ROOT = resolve('/srv/allaya/out/renderer');

describe('app protocol: path traversal defence', () => {
  it('serves the index and assets inside the renderer root', () => {
    expect(resolveAppRequest('allaya-app://app/', ROOT)).toEqual({
      ok: true,
      filePath: `${ROOT}${sep}index.html`,
      isHtml: true,
    });
    expect(resolveAppRequest('allaya-app://app/assets/index-abc.js', ROOT)).toMatchObject({
      ok: true,
      isHtml: false,
    });
    expect(
      resolveAppRequest('allaya-app://app/assets/%E0%A6%AB%E0%A6%BE%E0%A6%87%E0%A6%B2.css', ROOT),
    ).toMatchObject({ ok: true });
  });

  /** The invariant that matters: whatever the input, a served path is inside the root. */
  const confined = (url: string) => {
    const result = resolveAppRequest(url, ROOT);
    return !result.ok || result.filePath === ROOT || result.filePath.startsWith(ROOT + sep);
  };

  it.each([
    'allaya-app://app/../secret.txt',
    'allaya-app://app/assets/../../../etc/passwd',
    'allaya-app://app/%2e%2e/%2e%2e/etc/passwd',
    'allaya-app://app/%2E%2E%2Fsecret',
    'allaya-app://app/assets/..%2f..%2fsecret',
    'allaya-app://app/..%5Csecret',
    'allaya-app://app/assets\\..\\secret',
    'allaya-app://app/C:/Windows/win.ini',
    'allaya-app://app/c:%5Cwindows%5Cwin.ini',
    'allaya-app://app/index.html%00.png',
    'allaya-app://app/./index.html',
    'allaya-app://app/../renderer-evil/x.js',
    'allaya-app://app//etc/passwd',
    'allaya-app://app/%2f%2fetc%2fpasswd',
    'allaya-app://app/....//....//etc/passwd',
  ])('never escapes the renderer root: %s', (url) => {
    expect(confined(url)).toBe(true);
  });

  it.each([
    'allaya-app://app/..%2fsecret', // encoded slash survives URL parsing → must be rejected after decoding
    'allaya-app://app/..%5Csecret',
    'allaya-app://app/assets\\..\\secret',
    'allaya-app://app/C:/Windows/win.ini',
    'allaya-app://app/c:%5Cwindows%5Cwin.ini',
    'allaya-app://app/index.html%00.png',
  ])('explicitly refuses %s', (url) => {
    expect(resolveAppRequest(url, ROOT).ok).toBe(false);
  });

  it('refuses other hosts, other schemes, and malformed URLs', () => {
    expect(resolveAppRequest('allaya-app://evil/index.html', ROOT)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(resolveAppRequest('https://app/index.html', ROOT)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(resolveAppRequest('file:///etc/passwd', ROOT)).toMatchObject({ ok: false, status: 403 });
    expect(resolveAppRequest('not a url', ROOT)).toMatchObject({ ok: false, status: 400 });
    expect(resolveAppRequest('allaya-app://app/%E0%A4%A', ROOT)).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe('nonce', () => {
  it('generates unguessable, unique nonces', () => {
    const set = new Set(Array.from({ length: 200 }, newNonce));
    expect(set.size).toBe(200);
    expect(newNonce().length).toBeGreaterThanOrEqual(22);
  });

  it('substitutes every placeholder in the served HTML', () => {
    const html = `<meta content="${NONCE_PLACEHOLDER}"><x data="${NONCE_PLACEHOLDER}">`;
    const out = injectNonce(html, 'abc123');
    expect(out).toBe('<meta content="abc123"><x data="abc123">');
    expect(out).not.toContain(NONCE_PLACEHOLDER);
  });
});

describe('CSP policy', () => {
  const csp = buildCsp({ nonce: 'N0NCE' });
  const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

  it('production allows no inline/eval script or style', () => {
    expect(csp).not.toContain('unsafe-eval');
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('style-src')).toBe("style-src 'self'");
    expect(directive('style-src-elem')).toBe("style-src-elem 'self' 'nonce-N0NCE'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('locks down the network, plugins, framing and base URI', () => {
    expect(directive('connect-src')).toBe("connect-src 'self'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('frame-src')).toBe("frame-src 'none'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('form-action')).toBe("form-action 'none'");
  });

  it('dev policy is relaxed only for the dev server origin', () => {
    const dev = buildCsp({ devServerUrl: 'http://localhost:5173' });
    expect(dev).toContain('ws://localhost:5173');
    expect(dev).toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe('renderer origin trust', () => {
  const config = { devServerUrl: undefined };
  it('trusts only the app origin', () => {
    expect(isTrustedRendererUrl('allaya-app://app/index.html', config)).toBe(true);
    expect(isTrustedRendererUrl('allaya-app://app/index.html#/gallery', config)).toBe(true);
    expect(isTrustedRendererUrl('allaya-app://evil/index.html', config)).toBe(false);
    expect(isTrustedRendererUrl('https://allaya-app.evil.com/index.html', config)).toBe(false);
    expect(isTrustedRendererUrl('file:///app/renderer/index.html', config)).toBe(false);
    expect(isTrustedRendererUrl('javascript:alert(1)', config)).toBe(false);
    expect(isTrustedRendererUrl('', config)).toBe(false);
  });
  it('trusts the dev server origin only when configured', () => {
    const dev = { devServerUrl: 'http://localhost:5173' };
    expect(isTrustedRendererUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isTrustedRendererUrl('http://localhost:5173/', config)).toBe(false);
  });
});
