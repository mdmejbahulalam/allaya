import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * Launches the PACKAGED app (not the development build) and checks that what the package promises is really there:
 * the archive loads, the native database driver loads from outside the archive, the migrations and icons were shipped,
 * the window renders from the app protocol, and the security posture holds in the shipped build.
 *
 *   pnpm --filter @allaya/desktop pack        # makes apps/desktop/release/<platform>-unpacked
 *   ALLAYA_PACKAGED_EXE=apps/desktop/release/linux-unpacked/allaya xvfb-run -a pnpm exec playwright test -c playwright.packaged.config.ts
 *
 * On Windows the path is apps\desktop\release\win-unpacked\Allaya.exe.
 */
const exe = process.env['ALLAYA_PACKAGED_EXE'];
test.skip(!exe, 'set ALLAYA_PACKAGED_EXE to a packaged build to run this');

test('the packaged app starts, stores data, and is as locked down as the development build', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'allaya-packaged-'));
  const app = await electron.launch({
    executablePath: exe!,
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
      `--user-data-dir=${profile}`,
    ],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // It is the shipped build: packaged, and an ordinary one (no test switches).
    const info = await app.evaluate(({ app: electronApp }) => ({
      packaged: electronApp.isPackaged,
      resources: process.resourcesPath,
    }));
    expect(info.packaged).toBe(true);
    for (const file of [
      join('migrations', 'meta', '_journal.json'),
      join('icons', 'icon.png'),
      join('icons', 'tray.png'),
      'app-update.yml',
    ]) {
      expect(existsSync(join(info.resources, file)), file).toBe(true);
    }

    // The page rendered from the archive through the app protocol, with the shell around it.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(page.url()).toMatch(/^allaya-app:\/\//);

    // The database driver and the migrations work: a write goes in and comes back.
    const wrote = await page.evaluate(async () => {
      const created = await window.allaya.invoke('memory:create', {
        category: 'facts',
        key: 'packaged',
        value: 'it works',
      });
      const listed = await window.allaya.invoke('memory:list');
      return { created: created.ok, count: listed.ok ? listed.data.memories.length : -1 };
    });
    expect(wrote).toEqual({ created: true, count: 1 });

    // Isolation and the test-only switches: none of them exist in the shipped build.
    const posture = await page.evaluate(async () => {
      const bridge = window.allaya as unknown as {
        invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; error?: { code: string } }>;
      };
      return {
        require: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
        keys: Object.keys(window.allaya).sort(),
        unknownChannel: (await bridge.invoke('fs:readFile', { path: 'C:/secret' })).error?.code,
      };
    });
    expect(posture).toEqual({
      require: 'undefined',
      process: 'undefined',
      keys: ['invoke', 'subscribe'],
      unknownChannel: 'UNKNOWN_CHANNEL',
    });

    // Updates are wired to the real feed in the shipped build (and say so honestly when it cannot be reached).
    const updates = await page.evaluate(async () => {
      const reply = await window.allaya.invoke('updates:getStatus');
      return reply.ok ? reply.data.state : 'failed';
    });
    expect(['idle', 'checking', 'error', 'up_to_date']).toContain(updates);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
