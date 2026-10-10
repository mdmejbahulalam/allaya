import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * Launches the PACKAGED program (not the development build) and checks that what the package promises is really there:
 * the archive loads, the native database driver loads from outside it, the icons were shipped, the window renders from the
 * app protocol, the connected-apps code (bundled in) runs, and the locked-down posture holds in the shipped build.
 *
 *   pnpm --filter @allaya/lite pack     # makes apps/lite/release/<platform>-unpacked
 *   ALLAYA_LITE_PACKAGED_EXE=apps/lite/release/linux-unpacked/allaya-lite \
 *     xvfb-run -a pnpm exec playwright test -c playwright.lite-packaged.config.ts
 *
 * On Windows the path is apps\lite\release\win-unpacked\Allaya Lite.exe.
 */
const exe = process.env['ALLAYA_LITE_PACKAGED_EXE'];
test.skip(!exe, 'set ALLAYA_LITE_PACKAGED_EXE to a packaged build to run this');

test('the packaged program starts, stores data, runs its connections code, and is locked down', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'allaya-lite-packaged-'));
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

    // It is the shipped build: packaged, with the images it needs.
    const info = await app.evaluate(({ app: electronApp }) => ({
      packaged: electronApp.isPackaged,
      resources: process.resourcesPath,
      userData: electronApp.getPath('userData'),
    }));
    expect(info.packaged).toBe(true);
    // It kept to the folder it was told, not the person's real data.
    expect(info.userData).toBe(profile);
    for (const file of [join('icons', 'icon.png'), join('icons', 'tray.png')]) {
      expect(existsSync(join(info.resources, file)), file).toBe(true);
    }

    // The page rendered from the archive through the app protocol.
    await expect(page.getByRole('textbox', { name: 'Message Allaya…' })).toBeVisible();
    expect(page.url()).toMatch(/^allaya-lite:\/\//);

    const bridge = (channel: string, payload?: unknown) =>
      page.evaluate(
        async ([c, p]) => {
          const w = window as unknown as {
            allaya: {
              invoke: (
                c: string,
                p?: unknown,
              ) => Promise<{ ok: boolean; data?: unknown; error?: { code: string } }>;
            };
          };
          return w.allaya.invoke(c as string, p);
        },
        [channel, payload] as const,
      );

    // The database driver and the migrations work: a write goes in and comes back.
    expect((await bridge('settings:set', { userName: 'Packaged' })).ok).toBe(true);
    expect(((await bridge('settings:get')).data as { userName: string }).userName).toBe('Packaged');

    // The connected-apps code is in the package and runs: an address nobody answers is reported, not a crash.
    const added = await bridge('mcp:add', {
      name: 'Nobody home',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
      auth: 'none',
    });
    expect(added.ok).toBe(true);
    await expect
      .poll(async () => ((await bridge('mcp:list')).data as Array<{ status: string }>)[0]?.status, {
        timeout: 20_000,
      })
      .toBe('error');

    // Isolation and the test-only switches: none of them exist in the shipped build.
    const posture = await page.evaluate(async () => {
      const w = window as unknown as {
        require?: unknown;
        process?: unknown;
        allaya: { invoke: (c: string, p?: unknown) => Promise<{ error?: { code: string } }> };
      };
      return {
        require: typeof w.require,
        process: typeof w.process,
        keys: Object.keys(w.allaya).sort(),
        unknownChannel: (await w.allaya.invoke('fs:readFile', { path: 'C:/secret' })).error?.code,
      };
    });
    expect(posture).toEqual({
      require: 'undefined',
      process: 'undefined',
      keys: ['invoke', 'subscribe'],
      unknownChannel: 'UNKNOWN_CHANNEL',
    });
    expect((await bridge('app:info')).data).toMatchObject({ e2e: false });
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
  }
});
