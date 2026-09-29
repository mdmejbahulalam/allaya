import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from './fake-ai';
import { launchApp, type LaunchedApp } from './fixtures';

let app: LaunchedApp | undefined;
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
});

const start = async (env: Record<string, string> = {}) => (app = await launchApp({ env }));
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
const windowState = (launched: LaunchedApp) =>
  launched.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.webContents.getURL().includes('#/floating'),
    );
    return win
      ? { exists: true, visible: win.isVisible(), destroyed: win.isDestroyed() }
      : { exists: false, visible: false, destroyed: true };
  });

test('with the tray on, closing the window keeps Allaya running, and asking for it again brings it back', async () => {
  const launched = await start({ ALLAYA_E2E_TRAY: '1' });
  expect(await windowState(launched)).toMatchObject({ exists: true, visible: true });

  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect
    .poll(() => windowState(launched))
    .toMatchObject({ visible: false, destroyed: false });
  // Still running: the main process answers, and the window has not been destroyed.
  expect(await launched.app.evaluate(({ app }) => app.isReady())).toBe(true);

  // A second launch (or the tray icon, or the show-Allaya key) puts the same window back.
  await launched.app.evaluate(({ app }) => app.emit('second-instance'));
  await expect.poll(() => windowState(launched)).toMatchObject({ visible: true, destroyed: false });
  await expect(launched.page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('with "keep running in the tray" off, closing the last window quits', async () => {
  const launched = await start({ ALLAYA_E2E_TRAY: '1' });
  await launched.page.evaluate(() =>
    window.allaya.invoke('settings:set', { key: 'general.minimizeToTray', value: false }),
  );
  const closed = launched.app.waitForEvent('close');
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await closed;
  app = undefined;
});

test('without a tray (as on a bare Linux display) closing the window closes normally, and Settings says so', async () => {
  const launched = await start();
  await nav(launched.page, 'Settings');
  await expect(launched.page.getByText(/No system tray was found on this computer/)).toBeVisible();
  await expect(
    launched.page.getByRole('switch', { name: 'Start Allaya with Windows' }),
  ).toBeDisabled();
  await expect(
    launched.page.getByText(/only available in the installed Windows app/),
  ).toBeVisible();
  const closed = launched.app.waitForEvent('close');
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await closed;
  app = undefined;
});

test('the "show Allaya" key is registered with the system and follows the setting', async () => {
  const launched = await start();
  const isIn = (key: string) =>
    launched.app.evaluate(({ globalShortcut }, k) => globalShortcut.isRegistered(k), key);
  const registered = await isIn('Ctrl+Alt+Space');
  await launched.page.evaluate(() =>
    window.allaya.invoke('settings:set', { key: 'shortcuts.showApp', value: 'Ctrl+Alt+J' }),
  );
  await expect.poll(() => isIn('Ctrl+Alt+J')).toBe(registered);
  expect(await isIn('Ctrl+Alt+Space')).toBe(false);
  // The status the window is told matches what the system did.
  const status = await launched.page.evaluate(async () => {
    const reply = await window.allaya.invoke('desktop:getStatus');
    return reply.ok ? reply.data.showAppKey : undefined;
  });
  expect(status).toMatchObject({ accelerator: 'Ctrl+Alt+J', registered });
});

test('updates: the person sees the version on offer, chooses to download, and restarts only when they choose', async () => {
  const launched = await start({ ALLAYA_E2E_UPDATE_VERSION: '9.9.9' });
  const { page } = launched;
  await page.evaluate(() =>
    window.allaya.invoke('settings:set', { key: 'updates.auto', value: false }),
  );
  await nav(page, 'Help');
  const card = page.getByTestId('updates-card');
  await expect(card).toContainText('You have version 0.1.0.');
  await card.getByRole('button', { name: 'Check for updates' }).click();
  await expect(card).toContainText('Version 9.9.9 is available.');
  await card.getByRole('button', { name: 'Download' }).click();
  await expect(card).toContainText('Version 9.9.9 is ready');
  await expect(card).toContainText("checked against the publisher's list");
  const closed = launched.app.waitForEvent('close');
  await card.getByRole('button', { name: 'Restart and install' }).click();
  await closed;
  app = undefined;
});

test('updates: with automatic updates on, a check downloads what it finds and then waits', async () => {
  const launched = await start({ ALLAYA_E2E_UPDATE_VERSION: '9.9.9' });
  await nav(launched.page, 'Help');
  const card = launched.page.getByTestId('updates-card');
  await card.getByRole('button', { name: 'Check for updates' }).click();
  await expect(card).toContainText('Version 9.9.9 is ready');
  await expect(card.getByRole('button', { name: 'Restart and install' })).toBeVisible();
  expect(await windowState(launched)).toMatchObject({ visible: true });
});

test('updates: a build with no update feed says so and offers nothing to press', async () => {
  const launched = await start();
  await nav(launched.page, 'Help');
  const card = launched.page.getByTestId('updates-card');
  await expect(card).toContainText('Updates are not available in this build.');
  await expect(card.getByRole('button')).toHaveCount(0);
});

test('the floating assistant: shows what Allaya is doing, STOP works from it, and it brings the app back', async () => {
  const ai = await FakeAi.start();
  ai.stall = true;
  try {
    const launched = await start({
      ALLAYA_E2E_TRAY: '1',
      ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }),
    });
    const { page } = launched;
    await nav(page, 'Models');
    const card = page
      .locator('div', { has: page.getByRole('heading', { name: 'Anthropic', exact: true }) })
      .filter({ has: page.getByRole('button', { name: /Add API key/ }) })
      .last();
    await card.getByRole('button', { name: /Add API key/ }).click();
    await page.getByLabel('API key').fill(FakeAi.VALID_KEY);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Anthropic connected')).toBeVisible();

    // Off by default; switching it on opens the bar as a second window.
    expect(launched.app.windows()).toHaveLength(1);
    const opened = launched.app.waitForEvent('window');
    await page.evaluate(() =>
      window.allaya.invoke('settings:set', { key: 'general.showFloatingAssistant', value: true }),
    );
    const bar = await opened;
    await bar.waitForLoadState('domcontentloaded');
    expect(bar.url()).toMatch(/#\/floating$/);
    await expect(bar.getByRole('group', { name: 'Allaya assistant' })).toBeVisible();
    await expect(bar.getByRole('status')).toHaveText('Ready');
    const flags = await launched.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('#/floating'),
      )!;
      return { onTop: win.isAlwaysOnTop(), size: win.getSize() };
    });
    expect(flags).toEqual({ onTop: true, size: [320, 56] });

    // It shows work in progress, and its STOP ends the main window's reply and says so there.
    await nav(page, 'Chat');
    const box = page.getByRole('textbox', { name: 'Message Allaya…' });
    await box.fill('tell me a long story');
    await box.press('Enter');
    await expect(bar.getByRole('status')).toHaveText('Working…');
    await bar.getByRole('button', { name: 'STOP' }).click();
    await expect(page.getByRole('log').getByText('Stopped', { exact: true }).first()).toBeVisible();
    await expect(bar.getByRole('status')).toHaveText('Ready');

    // With the main window hidden in the tray, "Open Allaya" on the bar puts it back.
    await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes('#/floating'))!
        .close(),
    );
    await expect.poll(async () => (await windowState(launched)).visible).toBe(false);
    await bar.getByTitle('Open Allaya').click();
    await expect
      .poll(() =>
        launched.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (w) => !w.webContents.getURL().includes('#/floating') && w.isVisible(),
          ),
        ),
      )
      .toBe(true);

    // Switching it off closes the bar.
    const closed = bar.waitForEvent('close');
    await page.evaluate(() =>
      window.allaya.invoke('settings:set', { key: 'general.showFloatingAssistant', value: false }),
    );
    await closed;
  } finally {
    await ai.stop();
  }
});
