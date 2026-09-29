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

const env = () => ({ ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) });
const start = async (userDataDir?: string) =>
  (app = await launchApp({ ...(userDataDir ? { userDataDir } : {}), env: env() }));

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();

test('"বাংলায় কথা বলো" switches the reply language with no AI provider configured', async () => {
  const { page } = await start();
  await page.getByRole('textbox', { name: 'What can I help you with?' }).fill('বাংলায় কথা বলো');
  await page.getByRole('button', { name: 'Send' }).click();

  const log = page.getByRole('log');
  await expect(log).toContainText('ঠিক আছে, এখন থেকে বাংলায় কথা বলব।');
  // Answered locally: no error card, and the provider was never contacted.
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(ai.requests).toHaveLength(0);

  // The reply is tagged as Bengali so the right font and screen-reader voice are used.
  await expect(log.locator('[lang="bn"]', { hasText: 'ঠিক আছে' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Reply language' })).toContainText('বাংলা');
});

test('the chat header selector changes the conversation language and it survives a restart', async () => {
  let session = await start();
  await session.page
    .getByRole('textbox', { name: 'What can I help you with?' })
    .fill('Speak English');
  await session.page.getByRole('button', { name: 'Send' }).click();
  await expect(session.page.getByRole('log')).toContainText('English from now on');
  const selector = session.page.getByRole('combobox', { name: 'Reply language' });
  await expect(selector).toContainText('English');

  await selector.click();
  await session.page.getByRole('option', { name: 'বাংলা' }).click();
  await expect(selector).toContainText('বাংলা');

  const userDataDir = session.userDataDir;
  await session.app.close();
  session = await launchApp({ userDataDir, env: env() });
  app = session;
  await nav(session.page, 'Chat');
  await session.page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('button', { name: /Speak English/ })
    .click();
  await expect(session.page.getByRole('combobox', { name: 'Reply language' })).toContainText(
    'বাংলা',
  );
});

test('the model is asked to reply in the language the user wrote in (Bengali, Banglish, English)', async () => {
  ai.reply = () => ['ঠিক আছে।'];
  const { page } = await start();
  await nav(page, 'Models');
  const card = page
    .locator('div', { has: page.getByRole('heading', { name: 'Anthropic', exact: true }) })
    .filter({ has: page.getByRole('button', { name: /Add API key/ }) })
    .last();
  await card.getByRole('button', { name: /Add API key/ }).click();
  await page.getByLabel('API key').fill(FakeAi.VALID_KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Anthropic connected')).toBeVisible();
  await nav(page, 'Chat');

  const composer = page.getByRole('textbox', { name: 'Message Allaya…' });
  const chatRequests = () => ai.requests.filter((r) => r.url.includes('/v1/messages'));
  const system = (i: number) => (chatRequests()[i]!.body as { system: string }).system;

  await composer.fill('amar Downloads folder ta open koro');
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText('ঠিক আছে।');
  expect(system(0)).toMatch(/Bengali/);
  expect(system(0)).toMatch(/latest message/);

  await page.getByRole('button', { name: 'Send' }).waitFor();
  await page.getByRole('button', { name: 'New conversation' }).first().click();
  await composer.fill('Please open my Downloads folder');
  await composer.press('Enter');
  await expect.poll(() => chatRequests().length).toBe(2);
  expect(system(1)).toMatch(/latest message is in English/);
});
