import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures';

let launched: LaunchedApp;
let violations: string[];

test.beforeEach(async () => {
  launched = await launchApp();
  violations = [];
  await launched.page.evaluate(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective}:${e.blockedURI}`,
      ),
    );
  });
});
test.afterEach(async () => {
  violations = await launched.page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  await launched.close();
  expect(violations, 'CSP violations during the test').toEqual([]);
});

const setSetting = (page: Page, key: string, value: unknown) =>
  page.evaluate(([k, v]) => window.allaya.invoke('settings:set', { key: k, value: v }), [
    key,
    value,
  ] as const);

const resize = (width: number, height: number) =>
  launched.app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!),
    [width, height],
  );

test('every screen in the sidebar renders with a heading or empty state', async () => {
  const { page } = launched;
  await resize(1440, 900);
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  for (const label of [
    'Home',
    'Chat',
    'Tasks',
    'Automations',
    'Computer',
    'Apps',
    'Browser',
    'Files',
    'Memory',
    'Models',
    'Activity',
    'Permissions',
    'Settings',
    'Help',
  ]) {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await expect(nav.getByRole('button', { name: label, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('main').locator('h1, h2').first()).toBeVisible();
  }
});

test('command palette: opens with Ctrl+K, filters, navigates by keyboard, closes with Escape', async () => {
  const { page } = launched;
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: /Type a command/ });
  await expect(input).toBeFocused();
  await input.fill('settings');
  await expect(page.getByRole('option').first()).toContainText('Ask Allaya');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(
    page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Settings', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  await page.keyboard.press('Control+k');
  await expect(input).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

test('palette finds Bengali-UI items by English keywords and vice-versa', async () => {
  const { page } = launched;
  await setSetting(page, 'language.ui', 'bn');
  await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('settings'); // English keyword, Bengali UI
  await expect(page.getByRole('option', { name: 'সেটিংস খুলুন' })).toBeVisible();
  await page.getByRole('combobox').fill('সেটিংস'); // Bengali query
  await expect(page.getByRole('option', { name: 'সেটিংস খুলুন' })).toBeVisible();
});

test('language switch to Bengali translates the shell and persists across restarts', async () => {
  const { page, userDataDir } = launched;
  await setSetting(page, 'language.ui', 'bn');
  await setSetting(page, 'profile.displayName', 'Babul');
  await expect(
    page
      .getByRole('navigation', { name: 'প্রধান নেভিগেশন' })
      .getByRole('button', { name: 'হোম', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /শুভ (সকাল|অপরাহ্ন|সন্ধ্যা|রাত্রি), Babul/,
  );
  await expect(page.locator('body')).toContainText('আমি কী করতে পারি?');
  // Bengali glyphs must render with Noto Sans Bengali, not a tofu fallback.
  const fontOk = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px "Noto Sans Bengali"', 'বাংলা');
  });
  expect(fontOk).toBe(true);

  await launched.app.close();
  const again = await launchApp({ userDataDir });
  await expect(again.page.locator('html')).toHaveAttribute('lang', 'bn');
  await expect(again.page.getByRole('heading', { level: 1 })).toContainText('Babul');
  await again.close();
  // afterEach closes the (already closed) first app — reopen a fresh one to keep the fixture valid.
  launched = await launchApp();
  await launched.page.evaluate(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
  });
});

test('theme, density, motion and accent apply live and are contrast-safe', async () => {
  const { page } = launched;
  await setSetting(page, 'appearance.theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await setSetting(page, 'appearance.density', 'compact');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await setSetting(page, 'appearance.animations', 'reduced');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await setSetting(page, 'appearance.accent', '#22c55e');
  const tokens = await page.evaluate(() => {
    const s = document.documentElement.style;
    return {
      accent: s.getPropertyValue('--accent'),
      solid: s.getPropertyValue('--accent-solid'),
      text: s.getPropertyValue('--accent-text'),
    };
  });
  expect(tokens.accent).toBe('#22c55e');
  expect(tokens.solid).not.toBe('');
  expect(tokens.text).not.toBe('');
});

test('responsive layout follows the window-size tiers', async () => {
  const { page } = launched;
  const context = page.getByRole('complementary', { name: 'Live activity panel' });
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });

  await resize(1800, 1000);
  await expect(context).toBeVisible();
  expect((await nav.boundingBox())!.width).toBeGreaterThan(240);

  await resize(1300, 800);
  await expect(context).toBeVisible(); // compact, docked

  await resize(1150, 800);
  await expect(context).toBeHidden(); // md: drawer, closed by default
  await page.getByRole('button', { name: 'Show live activity' }).click();
  await expect(context).toBeVisible(); // opened as a drawer

  // Tooltips are suppressed under overlays, so a single Escape must close the drawer.
  await page.keyboard.press('Escape');
  await expect(context).toBeHidden();
  await resize(1000, 700);
  await expect.poll(async () => (await nav.boundingBox())!.width).toBeLessThan(100); // sm: forced collapsed rail
  // The critical controls must remain reachable at the smallest size.
  await expect(page.getByRole('button', { name: /Search or ask Allaya/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
});

test('keyboard: the skip link is the first tab stop and moves focus to main content', async () => {
  const { page } = launched;
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('dialogs, dropdowns and toasts work under the strict CSP (no violations)', async () => {
  const { page } = launched;
  await page.evaluate(() => {
    location.hash = '#/gallery';
  });
  await page.getByRole('button', { name: 'Open modal' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('combobox', { name: 'Model' }).click();
  await expect(page.getByRole('option', { name: /GPT/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Open confirmation' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused(); // safe default focus
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Success', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Notifications' }).getByRole('status')).toContainText(
    'Task completed',
  );
});

test('settings changes are validated by main and reflected in the UI', async () => {
  const { page } = launched;
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language' }).click();
  await page.getByRole('option', { name: 'বাংলা' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
});
