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

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
const card = (page: Page, name: string) =>
  page
    .locator('div[class*="flex-col"]', { has: page.getByRole('heading', { name, level: 3 }) })
    .last();

test('connect a server at an address, see the models it offers, choose one, and chat through it', async () => {
  app = await launchApp();
  const { page } = app;
  await nav(page, 'Models');

  const custom = card(page, 'Custom (OpenAI-compatible)');
  await custom.getByRole('button', { name: 'Set up' }).click();
  const address = page.getByRole('textbox', { name: 'Address' });
  await address.fill('http://example.com/v1'); // cleartext to another machine: refused, and nothing was sent
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Only a server on this computer can use http/)).toBeVisible();
  expect(ai.requests).toHaveLength(0);

  await address.fill(`${ai.url}/custom/v1`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Custom (OpenAI-compatible) connected')).toBeVisible();
  await expect(custom).toContainText(`${ai.url}/custom/v1`);
  await expect(custom).toContainText('qwen2.5:7b');
  // It asked for the model list, with the stand-in for "no key", and nothing else.
  expect(ai.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /custom/v1/models']);

  // Choose one of its models for general chat.
  await page.getByRole('switch', { name: 'Automatic model selection' }).click();
  await page.getByRole('combobox', { name: 'General', exact: true }).click();
  await page.getByRole('option', { name: /llama3.2:3b/ }).click();

  await nav(page, 'Chat');
  const composer = page.getByRole('textbox', { name: 'Message Allaya…' });
  await composer.fill('hello there');
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText('Custom says: hello there', {
    timeout: 15_000,
  });
  const chat = ai.requests.find((r) => r.url === '/custom/v1/chat/completions')!;
  expect(chat.body).toMatchObject({ model: 'llama3.2:3b', stream: true });

  // Disconnecting forgets it.
  await nav(page, 'Models');
  await card(page, 'Custom (OpenAI-compatible)')
    .getByRole('button', { name: 'Disconnect' })
    .click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(
    card(page, 'Custom (OpenAI-compatible)').getByRole('button', { name: 'Set up' }),
  ).toBeVisible();
});
