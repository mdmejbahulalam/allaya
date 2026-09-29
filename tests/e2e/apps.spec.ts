import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures';

let app: LaunchedApp | undefined;
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
});

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
const card = (page: Page, name: string) =>
  page.getByTestId('app-card').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('on a computer that cannot control apps the screen says so and offers nothing it cannot do', async () => {
  app = await launchApp();
  const { page } = app;
  await nav(page, 'Apps');
  await expect(page.getByRole('heading', { name: 'Applications', level: 1 })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'cannot open or control apps',
  );
  await expect(page.getByTestId('app-card').first()).toBeVisible();
  expect(await page.getByTestId('app-card').count()).toBeGreaterThan(30);
  const chrome = card(page, 'Chrome');
  await expect(chrome).toContainText('Install status unknown');
  await expect(chrome).toContainText('Not available here');
  await expect(chrome.getByRole('button', { name: 'Open Chrome' })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search apps' }).fill('blend');
  await expect(page.getByTestId('app-card')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search apps' }).fill('');
  await card(page, 'Chrome').getByRole('button', { name: 'Manage permissions' }).click();
  await expect(page.getByRole('heading', { name: 'Permissions', level: 1 })).toBeVisible();
});

test('with a desktop to work on: what is installed and running, and open, switch to and close through the normal safeguards', async () => {
  app = await launchApp({ env: { ALLAYA_E2E_COMPUTER: 'memory' } });
  const { page } = app;
  await nav(page, 'Apps');
  const chrome = card(page, 'Chrome');
  await expect(chrome).toContainText('Installed');
  await expect(chrome).toContainText('Running');
  await expect(chrome).toContainText('Full control');
  await expect(card(page, 'Blender')).toContainText('Not installed');
  await expect(card(page, 'Notepad')).toContainText('Not running');
  await expect(card(page, 'Notepad')).toContainText('Not used by Allaya yet');

  // Opening a harmless app needs no question (as when the AI opens it), is recorded, and shows as running and used.
  await card(page, 'Notepad').getByRole('button', { name: 'Open Notepad' }).click();
  await expect(card(page, 'Notepad')).toContainText('Running');
  await expect(card(page, 'Notepad')).toContainText('Last used by Allaya');

  // A shell is riskier: it asks first, and saying no opens nothing.
  await card(page, 'PowerShell').getByRole('button', { name: 'Open PowerShell' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirmation required' });
  await expect(dialog).toContainText('PowerShell');
  await dialog.getByRole('button', { name: "Don't allow" }).click();
  await expect(card(page, 'PowerShell')).toContainText('Not running');

  // Closing asks (closing can lose work); allowing closes it.
  await card(page, 'Chrome').getByRole('button', { name: 'Close Chrome' }).click();
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  await expect(card(page, 'Chrome')).toContainText('Not running');

  // The activity record shows what was done.
  await nav(page, 'Activity');
  await expect(page.getByTestId('activity-entry').first()).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('Notepad');
  await expect(page.getByTestId('activity-entry')).toHaveCount(1);
});
