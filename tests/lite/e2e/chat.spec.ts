import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from '../../e2e/fake-ai';
import { launchLite, type LaunchedApp } from './fixtures';

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
  (app = await launchLite({
    ...(userDataDir ? { userDataDir } : {}),
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) },
  }));

const settings = (page: Page) => page.getByRole('button', { name: /^(Settings|সেটিংস)$/ }).click();
const chatRequests = () => ai.requests.filter((r) => r.url === '/v1/messages');
const say = async (page: Page, text: string) => {
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill(text);
  await box.press('Enter');
};
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' });

async function connectAnthropic(page: Page) {
  await settings(page);
  await page.getByRole('button', { name: 'Add a service' }).click();
  await page.getByRole('button', { name: 'Anthropic (Claude)' }).click();
  await page.getByLabel('API key').fill(FakeAi.VALID_KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('“Anthropic (Claude)” connected.')).toBeVisible();
}

test('first run: nothing is connected, the person adds a service and has a conversation', async () => {
  const { page } = await start();
  await expect(page.getByRole('heading', { name: 'Connect an AI service to begin' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Allaya…' })).toBeVisible();

  await page.getByRole('button', { name: 'Connect a service' }).click();
  await expect(page.getByRole('heading', { name: 'AI services', level: 2 })).toBeVisible();
  await connectAnthropic(page);

  // The key is not left on the screen, and the card shows only a hint of it.
  await expect(page.getByTestId('connection')).toContainText('Anthropic (Claude)');
  await expect(page.getByTestId('connection')).toContainText('Key sk-…');
  expect(await page.content()).not.toContain(FakeAi.VALID_KEY);

  await page.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText(/^Connected · \d+ models$/)).toBeVisible();

  await page.getByRole('button', { name: 'Back to chat' }).click();
  await expect(page.getByRole('heading', { name: 'How can I help?' })).toBeVisible();
  await say(page, 'Hello there');
  await expect(log(page).getByText('Echo: Hello there')).toBeVisible();
  // The chat appears in the list under its first words, and the box is ready for the next message.
  await expect(
    page.getByRole('navigation', { name: 'Chats' }).getByRole('button', { name: 'Hello there' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Allaya…' })).toBeFocused();
  expect(chatRequests()).toHaveLength(1);
  const sent = chatRequests()[0]!.headers['x-api-key'];
  expect(sent).toBe(FakeAi.VALID_KEY);
});

test('any model of any connected service can be chosen, in this chat, with a search', async () => {
  ai.reply = (text) => [`Reply to ${text}`];
  const { page } = await start();
  await connectAnthropic(page);
  await page.getByRole('button', { name: 'Back to chat' }).click();

  await page.getByRole('button', { name: /^Model:/ }).click();
  const list = page.getByRole('listbox', { name: 'Choose a model' });
  await expect(list.getByRole('option')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Search models' }).fill('haiku');
  await expect(list.getByRole('option')).toHaveCount(1);
  await list.getByRole('option', { name: /Haiku/ }).click();
  await say(page, 'one');
  await expect(log(page).getByText('Reply to one')).toBeVisible();
  expect((chatRequests()[0]!.body as { model: string }).model).toMatch(/haiku/i);

  // Another chat is free to use another model.
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('option', { name: /Sonnet/ }).click();
  await say(page, 'two');
  await expect(log(page).getByText('Reply to two')).toBeVisible();
  expect((chatRequests()[1]!.body as { model: string }).model).toMatch(/sonnet/i);
});

test('a reply can be stopped, and what was written stays', async () => {
  ai.stall = true;
  const { page } = await start();
  await connectAnthropic(page);
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await say(page, 'Tell me a long story');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Stopped')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});

test('a wrong key is explained in plain words', async () => {
  const { page } = await start();
  await settings(page);
  await page.getByRole('button', { name: 'Add a service' }).click();
  await page.getByRole('button', { name: 'Anthropic (Claude)' }).click();
  await page.getByLabel('API key').fill('sk-ant-api03-WRONGWRONGWRONGWRONG');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('“Anthropic (Claude)” connected.')).toBeVisible();
  await page.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not connect' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await say(page, 'hello');
  await expect(page.getByRole('alert')).toContainText('did not accept the key');
});

test('any OpenAI-compatible address can be added, with its models listed from it', async () => {
  const { page } = await start();
  await settings(page);
  await page.getByRole('button', { name: 'Add a service' }).click();
  await page.getByRole('button', { name: 'Any other (OpenAI-compatible address)' }).click();
  await page.getByLabel('Name', { exact: true }).fill('My local server');
  await page.getByLabel('Address', { exact: true }).fill(`${ai.url}/custom/v1`);
  await page.getByLabel('API key').fill('local-key-123456');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('“My local server” connected.')).toBeVisible();
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('option', { name: 'qwen2.5:7b' }).click();
  await say(page, 'hi custom');
  await expect(log(page).getByText('Custom says: hi custom')).toBeVisible();
});

test('an address that would send the key unencrypted is refused', async () => {
  const { page } = await start();
  await settings(page);
  await page.getByRole('button', { name: 'Add a service' }).click();
  await page.getByRole('button', { name: 'Any other (OpenAI-compatible address)' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Plain');
  await page.getByLabel('Address', { exact: true }).fill('http://models.example.com/v1');
  await page.getByLabel('API key').fill('local-key-123456');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('Use https://');
});

test('everything is kept when the app is closed and opened again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allaya-lite-profile-'));
  try {
    let launched = await start(dir);
    await connectAnthropic(launched.page);
    await launched.page.getByRole('button', { name: 'Back to chat' }).click();
    await say(launched.page, 'Remember this chat');
    await expect(log(launched.page).getByText('Echo: Remember this chat')).toBeVisible();
    await launched.close();

    launched = await start(dir);
    const chats = launched.page.getByRole('navigation', { name: 'Chats' });
    await chats.getByRole('button', { name: 'Remember this chat' }).click();
    await expect(log(launched.page).getByText('Echo: Remember this chat')).toBeVisible();
    // The key survived too: the next message works without entering it again.
    await say(launched.page, 'And again');
    await expect(log(launched.page).getByText('Echo: And again')).toBeVisible();
    // Deleting a chat removes it.
    await launched.page
      .getByRole('button', { name: 'Delete chat “Remember this chat”' })
      .click({ force: true });
    await expect(chats.getByRole('button', { name: 'Remember this chat' })).toHaveCount(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the whole screen can be in Bengali, and the name is আলেয়া', async () => {
  const { page } = await start();
  await settings(page);
  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByLabel('Language').selectOption('bn');
  await expect(page.getByRole('heading', { name: 'সেটিংস', level: 1 })).toBeVisible();
  await expect(page.getByText('আলেয়া', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'চ্যাটে ফিরুন' }).click();
  await expect(page.getByRole('button', { name: 'নতুন চ্যাট' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'শুরু করতে একটি এআই সেবা যুক্ত করুন' }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
});

test('light and dark are both available', async () => {
  const { page } = await start();
  await settings(page);
  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByLabel('Appearance').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
