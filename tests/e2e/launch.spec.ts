import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures';

let launched: LaunchedApp;
test.beforeEach(async () => {
  launched = await launchApp();
});
test.afterEach(async () => {
  await launched.close();
});

test('app launches and completes an IPC round trip to the trusted main process', async () => {
  const { page } = launched;
  expect(await page.title()).toBe('Allaya');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Version comes from main via `app:getInfo` (Help screen renders it).
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Help', exact: true })
    .click();
  await expect(
    page.getByRole('region').or(page.locator('dl')).filter({ hasText: '0.1.0' }).first(),
  ).toBeVisible();
});

test('renderer is isolated: no Node.js, no Electron internals, only the two bridge functions', async () => {
  const { page } = launched;
  const probe = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    buffer: typeof (window as unknown as { Buffer?: unknown }).Buffer,
    bridgeKeys: Object.keys(window.allaya).sort(),
  }));
  expect(probe).toEqual({
    require: 'undefined',
    process: 'undefined',
    buffer: 'undefined',
    bridgeKeys: ['invoke', 'subscribe'],
  });
});

test('main rejects unknown channels and malformed payloads with structured errors', async () => {
  const { page } = launched;
  const results = await page.evaluate(async () => {
    const bridge = window.allaya as unknown as {
      invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; error?: { code: string } }>;
    };
    return {
      unknown: await bridge.invoke('fs:readFile', { path: 'C:/secret' }),
      badSetting: await bridge.invoke('settings:set', { key: 'appearance.theme', value: 'neon' }),
      arbitraryKey: await bridge.invoke('settings:set', { key: 'constructor.prototype', value: 1 }),
    };
  });
  expect(results.unknown).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });
  expect(results.badSetting).toMatchObject({ ok: false, error: { code: 'INVALID_IPC_PAYLOAD' } });
  expect(results.arbitraryKey).toMatchObject({ ok: false, error: { code: 'INVALID_IPC_PAYLOAD' } });
});

test('a strict nonce-based CSP header is served and inline injection is blocked', async () => {
  const { page } = launched;
  const csp = await page.evaluate(
    async () => (await fetch(location.href)).headers.get('content-security-policy') ?? '',
  );
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).toMatch(/style-src-elem 'self' 'nonce-[A-Za-z0-9+/=]{20,}'/);

  // The nonce the renderer was handed must be exactly the one in the header of *that* document:
  // a <style> carrying it is honoured, the same <style> without it is blocked.
  const nonceInDom = await page.evaluate(
    () => document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '',
  );
  expect(nonceInDom).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
  expect(nonceInDom).not.toContain('__CSP_NONCE__');

  const result = await page.evaluate((nonce) => {
    const probe = (id: string, withNonce: boolean) => {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
      const style = document.createElement('style');
      if (withNonce) style.nonce = nonce;
      style.textContent = `#${id}{display:block;width:123px}`;
      document.head.appendChild(style);
      return getComputedStyle(el).width;
    };
    const w = window as unknown as { __pwned?: boolean };
    w.__pwned = false;
    const script = document.createElement('script');
    script.textContent = 'window.__pwned = true';
    document.head.appendChild(script);
    return {
      withNonce: probe('p-with', true),
      withoutNonce: probe('p-without', false),
      executed: w.__pwned,
    };
  }, nonceInDom);
  expect(result.withNonce).toBe('123px');
  expect(result.withoutNonce).not.toBe('123px');
  expect(result.executed).toBe(false);
});

test('each document load gets a different nonce', async () => {
  const first = await launched.page.evaluate(
    () => document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')!.content,
  );
  const second = await launched.page.evaluate(async () => {
    const html = await (await fetch('/index.html')).text();
    return /name="csp-nonce" content="([^"]+)"/.exec(html)?.[1];
  });
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
});

test('the renderer is served from the app protocol, never file://, and traversal is refused', async () => {
  const { page } = launched;
  expect(page.url()).toMatch(/^allaya-app:\/\/app\//);
  const statuses = await page.evaluate(async () => {
    const get = async (path: string) => (await fetch(path)).status;
    return {
      index: await get('/index.html'),
      encodedTraversal: await get('/..%2f..%2fpackage.json'),
      backslash: await get('/..%5Cpackage.json'),
      missing: await get('/does-not-exist.js'),
    };
  });
  expect(statuses.index).toBe(200);
  expect(statuses.encodedTraversal).toBe(403);
  expect(statuses.backslash).toBe(403);
  expect(statuses.missing).toBe(404);
});
