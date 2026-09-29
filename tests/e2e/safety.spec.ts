import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from './fake-ai';
import { launchApp, type LaunchedApp } from './fixtures';

let ai: FakeAi;
let app: LaunchedApp | undefined;
let sandbox: string;

test.beforeEach(async () => {
  ai = await FakeAi.start();
  sandbox = mkdtempSync(join(tmpdir(), 'allaya-e2e-safety-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await ai.stop();
  rmSync(sandbox, { recursive: true, force: true });
});

const start = async (userDataDir?: string) =>
  (app = await launchApp({
    ...(userDataDir ? { userDataDir } : {}),
    env: {
      ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }),
      ALLAYA_E2E_FILES_DIR: sandbox,
    },
  }));
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
const say = async (page: Page, text: string) => {
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill(text);
  await box.press('Enter');
};
const registered = (launched: LaunchedApp, accelerator: string) =>
  launched.app.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), accelerator);

async function connect(page: Page) {
  await nav(page, 'Models');
  const card = page
    .locator('div', { has: page.getByRole('heading', { name: 'Anthropic', exact: true }) })
    .filter({ has: page.getByRole('button', { name: /Add API key/ }) })
    .last();
  await card.getByRole('button', { name: /Add API key/ }).click();
  await page.getByLabel('API key').fill(FakeAi.VALID_KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Anthropic connected')).toBeVisible();
}

test('the Permissions screen changes what Allaya may do, remembers it, and can put it all back', async () => {
  const first = await start();
  const { page } = first;
  await nav(page, 'Permissions');
  await expect(page.getByRole('heading', { name: 'Permissions', level: 1 })).toBeVisible();
  const clipboard = page.getByRole('combobox', { name: 'Setting for Clipboard' });
  await expect(clipboard).toHaveValue('ask');
  // Sensitive actions cannot even be offered "always allow".
  await expect(
    page.getByRole('combobox', { name: 'Setting for Delete files' }).getByRole('option'),
  ).toHaveText(['Ask every time', 'Never allow']);

  await clipboard.selectOption('never');
  await expect(clipboard).toHaveValue('never');
  const userDataDir = first.userDataDir;
  await first.app.close();
  app = undefined;

  const second = await start(userDataDir);
  await nav(second.page, 'Permissions');
  await expect(second.page.getByRole('combobox', { name: 'Setting for Clipboard' })).toHaveValue(
    'never',
  );
  await second.page.getByRole('button', { name: 'Reset to defaults' }).click();
  await second.page.getByRole('dialog').getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(second.page.getByRole('combobox', { name: 'Setting for Clipboard' })).toHaveValue(
    'ask',
  );
  await expect(second.page.getByText('Permissions reset')).toBeVisible();
  await second.close();
  app = undefined;
  rmSync(userDataDir, { recursive: true, force: true });
});

test('the emergency-stop key is really registered with the system, follows the setting, and the screen tells the truth about it', async () => {
  const launched = await start();
  const { page } = launched;
  await nav(page, 'Permissions');
  const card = page.getByTestId('stop-card');
  const isIn = await registered(launched, 'Ctrl+Shift+Escape');
  if (isIn) {
    await expect(card).toContainText('stops everything from anywhere');
  } else {
    // A machine that refuses the key (or has no shortcut support) must be told about it, never left to assume.
    await expect(card.getByRole('alert')).toBeVisible();
  }

  // Choosing another key moves the registration.
  await page.evaluate(() =>
    window.allaya.invoke('settings:set', { key: 'shortcuts.emergencyStop', value: 'Ctrl+Alt+K' }),
  );
  await expect.poll(async () => registered(launched, 'Ctrl+Alt+K'), { timeout: 5000 }).toBe(isIn);
  expect(await registered(launched, 'Ctrl+Shift+Escape')).toBe(false);
  if (isIn) await expect(card).toContainText('Alt');
  test.info().annotations.push({
    type: 'os-registration',
    description: isIn
      ? 'The operating system accepted the key.'
      : 'The operating system did not accept the key here.',
  });
});

test('the emergency-stop key works from a text field and ends a reply in progress', async () => {
  ai.stall = true;
  const { page } = await start();
  await connect(page);
  await nav(page, 'Chat');
  await say(page, 'tell me a long story');
  await expect(page.getByRole('button', { name: 'STOP', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Allaya…' }).click();
  await page.keyboard.press('Control+Shift+Escape');
  await expect(page.getByRole('log').getByText('Stopped', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'STOP', exact: true })).toHaveCount(0);
});

test('the Activity screen records what Allaya did, can be narrowed, and can be cleared', async () => {
  ai.turns = [
    { calls: [{ id: 't1', name: 'get_datetime', input: {} }] },
    { text: ['It is time.'] },
  ];
  const { page } = await start();
  await connect(page);
  await nav(page, 'Chat');
  await say(page, 'what time is it');
  await expect(page.getByRole('log').getByText('It is time.')).toBeVisible();

  await nav(page, 'Activity');
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  const rows = page.getByTestId('activity-entry');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('get_datetime');
  await expect(rows.first()).toContainText('Done');
  await expect(rows.first()).toContainText('Low risk');
  await expect(page.getByText('Kept for 90 days on this computer, then removed.')).toBeVisible();

  await page.getByRole('combobox', { name: 'Result' }).selectOption('denied');
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Result' }).selectOption('all');
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('datetime');
  await expect(rows).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('nothing like this');
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('');

  await page.getByRole('button', { name: 'Clear activity' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear activity' }).click();
  await expect(page.getByText('No activity yet.')).toBeVisible();
});

test('the window cannot be turned into a browser: no popups, no navigating away, no outside connections', async () => {
  const launched = await start();
  const { page } = launched;
  const before = page.url();
  const outcome = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(event.blockedURI);
    });
    const popup = window.open('ftp://example.invalid/', '_blank');
    let fetched = 'allowed';
    try {
      await fetch('https://example.com/');
    } catch {
      fetched = 'blocked';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { popup: popup === null ? 'refused' : 'opened', fetched, violations };
  });
  expect(outcome.popup).toBe('refused');
  expect(outcome.fetched).toBe('blocked');
  expect(outcome.violations.some((uri) => uri.includes('example.com'))).toBe(true);

  await page.evaluate(() => {
    window.location.href = 'ftp://example.invalid/';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  expect(launched.app.windows()).toHaveLength(1);
});
