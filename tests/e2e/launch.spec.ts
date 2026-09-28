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
  await expect(page.getByTestId('version')).toContainText('v0.1.0');
  expect(await page.title()).toBe('Allaya');
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

test('a strict CSP is applied and inline script execution is blocked', async () => {
  const { page } = launched;
  const csp = await page.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? '',
  );
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toContain('unsafe-eval');

  const executed = await page.evaluate(() => {
    (window as unknown as { __pwned?: boolean }).__pwned = false;
    const script = document.createElement('script');
    script.textContent = 'window.__pwned = true';
    document.head.appendChild(script);
    return (window as unknown as { __pwned?: boolean }).__pwned;
  });
  expect(executed).toBe(false);
});
