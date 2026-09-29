import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './fixtures';

let app: LaunchedApp | undefined;
let sandbox = '';
test.beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'allaya-diag-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  rmSync(sandbox, { recursive: true, force: true });
});

const openAdvanced = async (page: Page) => {
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Advanced', exact: true })
    .click();
};

test('Settings → Advanced shows how the app is doing, and exports a file without secrets or folder names', async () => {
  const file = join(sandbox, 'diagnostics.json');
  app = await launchApp({ env: { ALLAYA_E2E_SAVE_FILE: file } });
  const { page } = app;
  await openAdvanced(page);
  const box = page.getByRole('status', { name: 'Diagnostics' });
  await expect(box).toContainText('Allaya version');
  await expect(box).toContainText('Electron version');
  await expect(box).toContainText('Database');
  await expect(box).toContainText('AI providers');
  await expect(box).toContainText('0 of');

  await page.getByRole('button', { name: 'Export diagnostics' }).click();
  await expect(page.getByText('Diagnostics saved.')).toBeVisible();

  const text = readFileSync(file, 'utf8');
  const saved = JSON.parse(text) as { report: { app: { version: string } }; logTail: string };
  expect(saved.report.app.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(text).not.toContain(process.env['HOME'] ?? '/home/none-of-this');
  expect(text).not.toContain(sandbox);
});

test('the other Settings sections lead to where the settings are', async () => {
  app = await launchApp();
  const { page } = app;
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Memory', exact: true })
    .click();
  await page.getByRole('button', { name: /Open Memory/ }).click();
  await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
});
