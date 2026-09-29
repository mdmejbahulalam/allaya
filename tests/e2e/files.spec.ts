import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from './fake-ai';
import { launchApp, type LaunchedApp } from './fixtures';

let ai: FakeAi;
let app: LaunchedApp | undefined;
let sandbox: string;
let docs: string;
let outside: string;

test.beforeEach(async () => {
  ai = await FakeAi.start();
  sandbox = mkdtempSync(join(tmpdir(), 'allaya-e2e-files-'));
  docs = join(sandbox, 'Documents');
  outside = join(sandbox, 'Outside');
  for (const dir of [
    'Desktop',
    'Documents',
    'Downloads',
    'Pictures',
    'Videos',
    'Music',
    'Outside',
  ]) {
    mkdirSync(join(sandbox, dir), { recursive: true });
  }
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await ai.stop();
  rmSync(sandbox, { recursive: true, force: true });
});

const start = async (env: Record<string, string> = {}) =>
  (app = await launchApp({
    env: {
      ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }),
      ALLAYA_E2E_FILES_DIR: sandbox,
      ...env,
    },
  }));
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Confirmation required' });
const changes = (page: Page) => page.getByRole('region').filter({ hasText: 'What Allaya changed' });
const table = (page: Page) => page.getByRole('table', { name: 'Files' });

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
  await nav(page, 'Chat');
}
const say = async (page: Page, text: string) => {
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill(text);
  await box.press('Enter');
};
const chatRequests = () => ai.requests.filter((r) => r.url === '/v1/messages');
const toolResults = (index: number) =>
  (
    chatRequests()[index]!.body as { messages: Array<{ content: Array<{ content?: string }> }> }
  ).messages
    .at(-1)!
    .content.map(
      (c) =>
        JSON.parse(c.content!) as { ok: boolean; status: string; error?: string; output?: unknown },
    );

test('the Files screen shows the real folders, hides secrets, and stays inside the sandbox', async () => {
  writeFileSync(join(docs, 'notes.txt'), 'hello');
  writeFileSync(join(docs, '.env'), 'TOKEN=abc');
  mkdirSync(join(docs, 'Reports'));
  writeFileSync(join(docs, 'Reports', 'q1.txt'), 'q1');
  symlinkSync(outside, join(docs, 'shortcut-out'), 'dir');
  const { page } = await start();
  await nav(page, 'Files');
  await expect(page.getByRole('heading', { name: 'Files', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Documents' }).first().click();
  await expect(table(page).getByText('Reports')).toBeVisible();
  await expect(table(page).getByText('notes.txt')).toBeVisible();
  await expect(table(page).getByText('.env')).toHaveCount(0);
  await expect(
    page.getByText('1 item is hidden because it usually holds passwords or keys.'),
  ).toBeVisible();
  // a link that leaves the folders is shown as a shortcut and cannot be entered
  const shortcut = table(page).getByRole('row', { name: /shortcut-out/ });
  await expect(shortcut).toContainText('Shortcut');
  await expect(shortcut.getByRole('button', { name: 'shortcut-out', exact: true })).toHaveCount(0);

  await table(page).getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(table(page).getByText('q1.txt')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Folder path' })).toContainText('Documents');
  await page.getByRole('button', { name: 'Up one folder' }).click();
  await expect(table(page).getByText('notes.txt')).toBeVisible();
});

test('a folder created from the screen is real, audited, and can be undone (with a question first)', async () => {
  const { page } = await start();
  await nav(page, 'Files');
  await page.getByRole('button', { name: 'Documents' }).first().click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Projects বাংলা');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(table(page).getByText('Projects বাংলা')).toBeVisible();
  expect(existsSync(join(docs, 'Projects বাংলা'))).toBe(true);
  await expect(changes(page)).toContainText('Created the folder Projects বাংলা');

  await changes(page).getByRole('button', { name: 'Undo' }).click();
  await expect(dialog(page)).toContainText('Undo the change to');
  expect(existsSync(join(docs, 'Projects বাংলা'))).toBe(true); // nothing before the answer
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  await expect(table(page).getByText('Projects বাংলা')).toHaveCount(0);
  expect(existsSync(join(docs, 'Projects বাংলা'))).toBe(false);
  await expect(changes(page).getByText('Undone')).toBeVisible();
});

test('renaming asks first: "Deny" changes nothing, "Allow once" renames on disk', async () => {
  writeFileSync(join(docs, 'draft.txt'), 'x');
  const { page } = await start();
  await nav(page, 'Files');
  await page.getByRole('button', { name: 'Documents' }).first().click();

  await page.getByRole('button', { name: 'Rename: draft.txt' }).click();
  await page.getByLabel('New name').fill('final.txt');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog(page)).toContainText('Rename “Documents/draft.txt” to “final.txt”');
  await dialog(page).getByRole('button', { name: "Don't allow" }).click();
  await expect(page.getByText('You said no. Nothing changed.')).toBeVisible();
  expect(existsSync(join(docs, 'draft.txt'))).toBe(true);
  expect(existsSync(join(docs, 'final.txt'))).toBe(false);

  await page.getByRole('button', { name: 'Rename: draft.txt' }).click();
  await page.getByLabel('New name').fill('final.txt');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  await expect(table(page).getByText('final.txt')).toBeVisible();
  expect(existsSync(join(docs, 'final.txt'))).toBe(true);
  expect(existsSync(join(docs, 'draft.txt'))).toBe(false);
});

test('deleting a folder needs an on-screen click, goes to the trash, and comes back with undo', async () => {
  mkdirSync(join(docs, 'Old'));
  writeFileSync(join(docs, 'Old', 'keep.txt'), 'precious');
  const { page, userDataDir } = await start();
  await nav(page, 'Files');
  await page.getByRole('button', { name: 'Documents' }).first().click();
  await page.getByRole('button', { name: 'Move to trash: Old' }).click();
  await expect(dialog(page)).toContainText(
    'Move the folder “Documents/Old” and everything in it to the trash',
  );
  await expect(dialog(page)).toContainText('Critical');
  expect(existsSync(join(docs, 'Old', 'keep.txt'))).toBe(true);
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  await expect(table(page).getByRole('button', { name: 'Old', exact: true })).toHaveCount(0);
  expect(existsSync(join(docs, 'Old'))).toBe(false);
  expect(readdirSync(join(userDataDir, 'trash'))).toHaveLength(1); // moved, not destroyed

  await changes(page).getByRole('button', { name: 'Undo' }).click();
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  await expect(table(page).getByRole('button', { name: 'Old', exact: true })).toBeVisible();
  expect(readFileSync(join(docs, 'Old', 'keep.txt'), 'utf8')).toBe('precious');
});

test('search finds files by name across the folders', async () => {
  mkdirSync(join(docs, 'Reports'));
  writeFileSync(join(docs, 'Reports', 'Sales Report 2026.txt'), 'x');
  writeFileSync(join(sandbox, 'Desktop', 'sales-notes.txt'), 'x');
  writeFileSync(join(docs, 'unrelated.txt'), 'x');
  const { page } = await start();
  await nav(page, 'Files');
  await page.getByRole('searchbox').fill('sales');
  await expect(page.getByText('Results for “sales”')).toBeVisible();
  await expect(table(page).getByText('Sales Report 2026.txt')).toBeVisible();
  await expect(table(page).getByText('sales-notes.txt')).toBeVisible();
  await expect(table(page).getByText('unrelated.txt')).toHaveCount(0);
});

test('a folder the user adds becomes usable, and can be dropped again without deleting anything', async () => {
  const extra = join(sandbox, 'Outside', 'MyProject');
  mkdirSync(extra, { recursive: true });
  writeFileSync(join(extra, 'main.ts'), 'code');
  const { page } = await start({ ALLAYA_E2E_PICK_FOLDER: extra });
  await nav(page, 'Files');
  await page.getByRole('button', { name: 'Add a folder' }).click();
  await expect(page.getByText('Added “MyProject”.')).toBeVisible();
  await expect(table(page).getByText('main.ts')).toBeVisible();
  await page.getByRole('button', { name: 'Stop using MyProject' }).click();
  await expect(page.getByText(/no longer uses “MyProject”/)).toBeVisible();
  expect(readFileSync(join(extra, 'main.ts'), 'utf8')).toBe('code');
  await expect(page.getByRole('button', { name: /MyProject/ })).toHaveCount(0);
});

test("unsafe folders cannot be added: Allaya's own data and the whole sandbox parent", async () => {
  const { page, userDataDir } = await start({ ALLAYA_E2E_PICK_FOLDER: '' });
  await app!.close();
  app = undefined;
  const second = await launchApp({
    userDataDir,
    env: {
      ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }),
      ALLAYA_E2E_FILES_DIR: sandbox,
      ALLAYA_E2E_PICK_FOLDER: userDataDir,
    },
  });
  app = second;
  await nav(second.page, 'Files');
  await second.page.getByRole('button', { name: 'Add a folder' }).click();
  await expect(
    second.page.getByText('That is a system or Allaya location and cannot be used.'),
  ).toBeVisible();
  expect(page).toBeDefined();
});

test('"Documents e todo.txt banao": the model writes a file — after a question, verified, secrets and escapes refused', async () => {
  writeFileSync(join(docs, '.env'), 'TOKEN=abc123');
  writeFileSync(join(outside, 'passwords.txt'), 'hunter2');
  symlinkSync(outside, join(docs, 'shortcut-out'), 'dir');
  ai.turns = [
    {
      calls: [
        {
          id: 't1',
          name: 'write_file',
          input: { path: 'Documents/todo.txt', content: 'আজকের কাজ:\n১. বাজার' },
        },
      ],
    },
    {
      calls: [
        { id: 't2', name: 'read_file', input: { path: 'Documents/.env' } },
        { id: 't3', name: 'list_folder', input: { path: 'Documents/../Outside' } },
        { id: 't4', name: 'list_folder', input: { path: 'Documents/shortcut-out' } },
        { id: 't5', name: 'write_file', input: { path: 'Documents/run.bat', content: 'echo hi' } },
        { id: 't6', name: 'list_folder', input: { path: 'Documents' } },
      ],
    },
    { text: ['todo.txt তৈরি করেছি।'] },
  ];
  const { page } = await start();
  await connect(page);
  await say(page, 'Documents e todo.txt banao');

  // "banao" is Banglish, so the question is asked in Bengali.
  await expect(dialog(page)).toContainText('“Documents/todo.txt” তৈরি');
  expect(existsSync(join(docs, 'todo.txt'))).toBe(false); // nothing before the answer
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  // The next round of calls asks for the .env read (MEDIUM) and the batch script write (MEDIUM); the runtime refuses both.
  for (let i = 0; i < 2; i += 1) {
    await expect(dialog(page)).toBeVisible({ timeout: 15_000 });
    await dialog(page).getByRole('button', { name: 'Allow once' }).click();
    await page.waitForTimeout(200);
  }
  await expect(page.getByRole('log')).toContainText('todo.txt তৈরি করেছি।', { timeout: 20_000 });

  expect(readFileSync(join(docs, 'todo.txt'), 'utf8')).toBe('আজকের কাজ:\n১. বাজার');
  const second = toolResults(2);
  expect(second.map((r) => r.ok)).toEqual([false, false, false, false, true]);
  expect(second[0]!.error).toContain('passwords or keys');
  expect(second[1]!.error).toContain('..');
  expect(second[2]!.error).toContain('outside the allowed folders');
  expect(second[3]!.error).toContain('programs, scripts or shortcuts');
  expect(existsSync(join(docs, 'run.bat'))).toBe(false);
  expect(JSON.stringify(second)).not.toMatch(/abc123|hunter2/);
  // The first result the model saw says the write was verified.
  expect(toolResults(1)[0]).toMatchObject({ ok: true, verification: 'verified' });
});

test('the model can list and read a permitted file; reading asks first and says the text is sent to the AI', async () => {
  writeFileSync(join(docs, 'diary.txt'), 'আজ আমার জন্মদিন');
  ai.turns = [
    { calls: [{ id: 't1', name: 'read_file', input: { path: 'Documents/diary.txt' } }] },
    { text: ['পড়েছি।'] },
  ];
  const { page } = await start();
  await connect(page);
  await say(page, 'diary poro');
  await expect(dialog(page)).toContainText('sent to your AI provider');
  expect(chatRequests()).toHaveLength(1); // nothing has been read or sent yet
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('log')).toContainText('পড়েছি।', { timeout: 15_000 });
  expect(JSON.stringify(toolResults(1))).toContain('আজ আমার জন্মদিন');
});

test('turning file access off in Permissions blocks the screen and the tools', async () => {
  const { page } = await start();
  await page.evaluate(() =>
    (
      window as unknown as { allaya: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).allaya.invoke('permissions:set', { subject: 'file_access', mode: 'never' }),
  );
  await nav(page, 'Files');
  await expect(page.getByText('File access is switched off')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('the Files screen reads in Bengali with Bengali digits', async () => {
  writeFileSync(join(docs, 'a.txt'), 'x');
  const { page } = await start();
  await page.evaluate(async () => {
    const api = (
      window as unknown as { allaya: { invoke: (c: string, p: unknown) => Promise<unknown> } }
    ).allaya;
    await api.invoke('settings:set', { key: 'language.ui', value: 'bn' });
    await api.invoke('settings:set', { key: 'language.numerals', value: 'bengali' });
  });
  await page
    .getByRole('navigation', { name: 'প্রধান নেভিগেশন' })
    .getByRole('button', { name: 'ফাইল', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'ফাইল', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Documents' }).first().click();
  await expect(page.getByText('১টি আইটেম')).toBeVisible();
  await expect(page.getByRole('button', { name: /ট্র্যাশে পাঠান: a.txt/ })).toBeVisible();
});
