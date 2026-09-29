import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  sandbox = mkdtempSync(join(tmpdir(), 'allaya-e2e-memory-'));
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
      ALLAYA_E2E_SAVE_FILE: join(sandbox, 'memories.json'),
    },
  }));
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Confirmation required' });
const items = (page: Page) => page.getByTestId('memory-item');
const chatRequests = () => ai.requests.filter((r) => r.url === '/v1/messages');
const systemOf = (index: number) => (chatRequests()[index]!.body as { system: string }).system;
const say = async (page: Page, text: string) => {
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill(text);
  await box.press('Enter');
};

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

async function addMemory(page: Page, title: string, value: string, category = 'Preferences') {
  await page.getByRole('button', { name: 'Add a memory' }).first().click();
  const form = page.getByRole('dialog', { name: 'Add a memory' });
  await form.getByLabel('Category').selectOption({ label: category });
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('What should Allaya remember?').fill(value);
  await form.getByRole('button', { name: 'Save' }).click();
  return form;
}

test('the person adds, edits and forgets memories — and can see what is kept', async () => {
  const { page } = await start();
  await nav(page, 'Memory');
  await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
  await expect(page.getByText('Nothing remembered yet.')).toBeVisible();
  await expect(page.getByText(/Memories are stored only on this computer/)).toBeVisible();

  const form = await addMemory(page, 'preferred browser', 'Edge');
  await expect(form).toBeHidden();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText('preferred browser');
  await expect(items(page).first()).toContainText('Added by you');
  await expect(items(page).first()).toContainText('Not used yet');

  await addMemory(page, 'মায়ের নাম', 'ফাতেমা', 'Personal');
  await expect(items(page)).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search what Allaya remembers' }).fill('ফাতেমা');
  await expect(items(page)).toHaveCount(1);
  await page.getByRole('searchbox').fill('');

  await items(page).first().getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit memory' });
  await edit.getByLabel('What should Allaya remember?').fill('Firefox');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(items(page).first()).toContainText('Firefox');

  await items(page).first().getByRole('button', { name: 'Forget this' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Forget this' }).click();
  await expect(items(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Forget everything' }).click();
  await expect(page.getByText(/All 1 memories will be deleted/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Forget everything' }).click();
  await expect(page.getByText('Nothing remembered yet.')).toBeVisible();
});

test('a password is refused, with the reason, and never stored', async () => {
  const { page } = await start();
  await nav(page, 'Memory');
  const form = await addMemory(page, 'wifi', 'the password is hunter2', 'Facts');
  await expect(form.getByText(/looks like a password, key or card number/)).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Nothing remembered yet.')).toBeVisible();
});

test('memories are kept when Allaya is closed and opened again, and can be saved to a file', async () => {
  const first = await start();
  await nav(first.page, 'Memory');
  await addMemory(first.page, 'preferred browser', 'Edge');
  await expect(items(first.page)).toHaveCount(1);
  await first.page.getByRole('button', { name: 'Save a copy…' }).click();
  await expect(first.page.getByText('Saved 1 memories')).toBeVisible();
  const copied = readFileSync(join(sandbox, 'memories.json'), 'utf8');
  expect(JSON.parse(copied).memories).toEqual([
    expect.objectContaining({ category: 'preferences', key: 'preferred browser', value: 'Edge' }),
  ]);
  const userDataDir = first.userDataDir;
  await first.app.close();
  app = undefined;

  const second = await start(userDataDir);
  await nav(second.page, 'Memory');
  await expect(items(second.page)).toHaveCount(1);
  await expect(items(second.page).first()).toContainText('Edge');
  await second.close();
  app = undefined;
  rmSync(userDataDir, { recursive: true, force: true });
});

test('a reply that used a memory says so — and turning memory off stops it being used', async () => {
  ai.turns = [{ text: ['Opening Edge.'] }, { text: ['Sure.'] }];
  const { page } = await start();
  await connect(page);
  await nav(page, 'Memory');
  await addMemory(page, 'preferred browser', 'Edge');
  await expect(items(page)).toHaveCount(1);

  await nav(page, 'Chat');
  await say(page, 'please open my browser');
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText('Opening Edge.')).toBeVisible();
  expect(systemOf(0)).toContain('<memory>\n- [preferences] preferred browser: Edge\n</memory>');
  await expect(log.getByTestId('memory-used')).toHaveText('Used from memory: preferred browser');

  // The screen shows it was used, and the link leads there.
  await log.getByRole('button', { name: 'Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
  await expect(items(page).first()).toContainText('Used once');

  await page.getByRole('switch', { name: 'Let Allaya use and save memories' }).click();
  await expect(page.getByText('Memory is off')).toBeVisible();
  await nav(page, 'Chat');
  await say(page, 'and open my browser again');
  await expect(log.getByText('Sure.')).toBeVisible();
  expect(systemOf(1)).not.toContain('<memory>');
});

test('Allaya can only suggest a memory: it is saved after a yes on the screen, and shown as its suggestion', async () => {
  ai.turns = [
    {
      calls: [
        {
          id: 'r1',
          name: 'remember',
          input: { category: 'preferences', key: 'reply style', value: 'short answers' },
        },
      ],
    },
    { text: ['I will keep answers short.'] },
    {
      calls: [
        {
          id: 'r2',
          name: 'remember',
          input: { category: 'facts', key: 'colour', value: 'blue' },
        },
      ],
    },
    { text: ['Okay, not saving it.'] },
  ];
  const { page } = await start();
  await connect(page);
  await nav(page, 'Chat');
  await say(page, 'Please remember that I like short answers');
  await expect(dialog(page)).toContainText(
    'Remember (preferences): “reply style” — “short answers”',
  );
  await expect(dialog(page)).toContainText('High');
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText('I will keep answers short.')).toBeVisible();

  await say(page, 'and my favourite colour is blue, remember it');
  await expect(dialog(page)).toContainText('“colour” — “blue”');
  await dialog(page).getByRole('button', { name: "Don't allow" }).click();
  await expect(log.getByText('Okay, not saving it.')).toBeVisible();

  await nav(page, 'Memory');
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toContainText('reply style');
  await expect(items(page).first()).toContainText('Suggested by Allaya, approved by you');
});
