import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from './fake-ai';
import { launchApp, type LaunchedApp } from './fixtures';

let ai: FakeAi;
let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  ai = await FakeAi.start();
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await ai.stop();
});

const start = async (userDataDir?: string) =>
  (app = await launchApp({
    ...(userDataDir ? { userDataDir } : {}),
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) },
  }));

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();

async function connect(page: Page, key = FakeAi.VALID_KEY) {
  await nav(page, 'Models');
  const card = page
    .locator('div', { has: page.getByRole('heading', { name: 'Anthropic', exact: true }) })
    .filter({ has: page.getByRole('button', { name: /Add API key/ }) })
    .last();
  await card.getByRole('button', { name: /Add API key/ }).click();
  // The dialog must have an accessible name (regression: it once rendered with an empty title).
  await expect(page.getByRole('dialog', { name: 'Connect Anthropic' })).toBeVisible();
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
}

test('without a provider, a message gets an actionable error that leads to Models', async () => {
  const { page } = await start();
  await expect(page.getByText('AI provider not configured.').first()).toBeVisible();
  await page
    .getByRole('textbox', { name: 'What can I help you with?' })
    .fill('আমার Downloads folder খুলে দাও');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('log')).toContainText('আমার Downloads folder খুলে দাও');
  await expect(page.getByRole('alert')).toContainText("Couldn't get a reply");
  await page.getByRole('alert').getByRole('button', { name: 'Configure AI' }).click();
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
});

test('connecting a provider verifies the key, shows only a masked hint, and never exposes the secret', async () => {
  const { page, app: electron } = await start();
  await connect(page);

  await expect(page.getByText('Anthropic connected')).toBeVisible();
  await expect(page.getByText('sk-…0123')).toBeVisible();
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Online' })).toBeVisible();

  // The key went to the provider as a header, and is nowhere the renderer can reach.
  expect(ai.requests[0]!.headers['x-api-key']).toBe(FakeAi.VALID_KEY);
  const leaked = await page.evaluate((secret) => {
    const inDom = document.documentElement.outerHTML.includes(secret);
    const inStorage = JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret);
    return { inDom, inStorage };
  }, FakeAi.VALID_KEY);
  expect(leaked).toEqual({ inDom: false, inStorage: false });
  const list = await page.evaluate(async () =>
    JSON.stringify(await window.allaya.invoke('providers:list')),
  );
  expect(list).not.toContain('E2EVALIDKEY');
  void electron;
});

test('a rejected key is refused with a clear message and nothing is kept', async () => {
  const { page } = await start();
  await connect(page, 'sk-ant-api03-WRONGWRONGWRONGWRONG');
  await expect(
    page.getByRole('alert').filter({ hasText: 'The API key was rejected' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('AI not configured')).toBeVisible();
  const stored = await page.evaluate(async () =>
    JSON.stringify(await window.allaya.invoke('providers:list')),
  );
  expect(stored).not.toContain('WRONGWRONG');
  expect(stored).toContain('"status":"not_configured"');
});

test('chat streams a Bengali/English reply, keeps history, and survives a restart', async () => {
  ai.reply = (text) => ['বুঝেছি — ', `"${text}" `, 'করে দিচ্ছি।'];
  ai.chunkDelayMs = 40;
  let session = await start();
  await connect(session.page);
  await expect(session.page.getByText('Anthropic connected')).toBeVisible();
  await nav(session.page, 'Chat');

  const composer = session.page.getByRole('textbox', { name: 'Message Allaya…' });
  await composer.fill('Chrome খুলে Google এ search করো');
  await composer.press('Enter');

  const log = session.page.getByRole('log');
  await expect(log).toContainText('Chrome খুলে Google এ search করো');
  await expect(log).toContainText('বুঝেছি', { timeout: 10_000 });
  await expect(log).toContainText('করে দিচ্ছি।', { timeout: 10_000 });
  await expect(log).toContainText('via Claude Sonnet 5.5');

  // Enter sent it; Shift+Enter would have inserted a newline instead.
  await composer.fill('line one');
  await composer.press('Shift+Enter');
  await composer.type('line two');
  await expect(composer).toHaveValue('line one\nline two');
  await composer.fill('');

  const userDataDir = session.userDataDir;
  await session.app.close();
  session = await launchApp({
    userDataDir,
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) },
  });
  app = session;
  await nav(session.page, 'Chat');
  await session.page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('button', { name: /Chrome খুলে Google এ search করো/ })
    .click();
  await expect(session.page.getByRole('log')).toContainText('করে দিচ্ছি।');
  // The provider is still connected after restart, with the key intact in the encrypted store.
  await nav(session.page, 'Models');
  await expect(session.page.getByText('sk-…0123')).toBeVisible();
  await expect(session.page.getByRole('status').filter({ hasText: 'Online' })).toBeVisible();
});

test('STOP appears while Allaya works and halts generation, keeping the partial reply', async () => {
  ai.stall = true;
  ai.reply = () => ['Starting to write a very long answer', ' that never ends'];
  const { page } = await start();
  await connect(page);
  await expect(page.getByText('Anthropic connected')).toBeVisible();
  await nav(page, 'Chat');
  await page.getByRole('textbox', { name: 'Message Allaya…' }).fill('write an essay');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('log')).toContainText('Starting to write');
  const stop = page.getByRole('banner').getByRole('button', { name: /STOP/ });
  await expect(stop).toBeVisible(); // the always-visible emergency stop (header)
  await stop.click();

  await expect(page.getByRole('log').getByText('Stopped')).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Starting to write'); // partial text kept
  await expect(stop).toBeHidden();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible(); // composer is usable again
});

test('the composer Stop button also cancels the current reply', async () => {
  ai.stall = true;
  const { page } = await start();
  await connect(page);
  await expect(page.getByText('Anthropic connected')).toBeVisible();
  await nav(page, 'Chat');
  await page.getByRole('textbox', { name: 'Message Allaya…' }).fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Stop generating' }).click();
  await expect(page.getByRole('log').getByText('Stopped')).toBeVisible();
});

test('model routing choices persist across restarts', async () => {
  let session = await start();
  await connect(session.page);
  await expect(session.page.getByText('Anthropic connected')).toBeVisible();

  await session.page.getByRole('combobox', { name: 'Coding' }).click();
  await session.page.getByRole('option', { name: /Claude Haiku 4.5/ }).click();
  await session.page.getByRole('switch', { name: 'Automatic model selection' }).click();
  await expect(
    session.page.getByRole('switch', { name: 'Automatic model selection' }),
  ).toHaveAttribute('aria-checked', 'false');

  const userDataDir = session.userDataDir;
  await session.app.close();
  session = await launchApp({
    userDataDir,
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) },
  });
  app = session;
  await nav(session.page, 'Models');
  await expect(session.page.getByRole('combobox', { name: 'Coding' })).toContainText(
    'Claude Haiku 4.5',
  );
  await expect(
    session.page.getByRole('switch', { name: 'Automatic model selection' }),
  ).toHaveAttribute('aria-checked', 'false');
});

test('removing a key disconnects the provider and returns to the no-provider state', async () => {
  const { page } = await start();
  await connect(page);
  await expect(page.getByText('Anthropic connected')).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Anthropic disconnected')).toBeVisible();
  await expect(page.getByText('AI not configured')).toBeVisible();
});
