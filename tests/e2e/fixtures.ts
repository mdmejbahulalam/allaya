import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DESKTOP_DIR = join(REPO_ROOT, 'apps/desktop');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  close(): Promise<void>;
}

/** Launches the built Electron app with an isolated profile. Run `pnpm build` first. */
export async function launchApp(
  options: { userDataDir?: string; env?: Record<string, string> } = {},
): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'allaya-e2e-'));
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const app = await electron.launch({
    args: [...(isRoot || process.env['CI'] ? ['--no-sandbox'] : []), '--disable-gpu', DESKTOP_DIR],
    cwd: DESKTOP_DIR,
    env: {
      ...(process.env as Record<string, string>),
      ALLAYA_E2E: '1',
      ALLAYA_USER_DATA_DIR: userDataDir,
      ...options.env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return {
    app,
    page,
    userDataDir,
    async close() {
      await app.close();
      if (!options.userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
