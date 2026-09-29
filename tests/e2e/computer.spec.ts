import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

const start = async () =>
  (app = await launchApp({
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) },
  }));
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();

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

test('the Computer screen tells the truth about this machine: screenshots and clipboard yes, windows/keyboard/mouse no', async () => {
  const { page } = await start();
  await nav(page, 'Computer');
  await expect(page.getByRole('heading', { name: 'Computer', level: 1 })).toBeVisible();
  const available = (name: string) => page.locator('[data-available]').filter({ hasText: name });
  await expect(available('Take screenshots')).toHaveAttribute('data-available', 'true');
  await expect(available('Read and write the clipboard')).toHaveAttribute('data-available', 'true');
  await expect(available('Type and press shortcuts')).toHaveAttribute('data-available', 'false');
  await expect(available('Open applications')).toHaveAttribute('data-available', 'false');
  await expect(page.getByRole('note')).toContainText('Windows only');
  // Only the tools that can work here are listed — none that would type or click.
  await expect(page.getByText('take_screenshot')).toBeVisible();
  await expect(page.getByText('write_clipboard')).toBeVisible();
  await expect(page.getByText('type_text')).toHaveCount(0);
  await expect(page.getByText('open_app')).toHaveCount(0);
});

test('the safe self-check captures the real screen and skips what does not exist here', async () => {
  const { page } = await start();
  await nav(page, 'Computer');
  await page.getByRole('button', { name: 'Run a safe check' }).click();
  const report = page.getByRole('status').filter({ hasText: 'Everything responded.' });
  await expect(report).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-skipped="true"]')).toContainText('List windows');
  await expect(
    page
      .locator('[data-ok="true"]:not([data-skipped="true"])')
      .filter({ hasText: 'Capture the screen' }),
  ).toContainText('pixels');
});

test('"screenshot nao": a real screenshot is captured, saved as a PNG, and verified', async () => {
  ai.turns = [
    { calls: [{ id: 'toolu_s', name: 'take_screenshot', input: {} }] },
    { text: ['স্ক্রিনশট নিয়েছি।'] },
  ];
  const session = await start();
  const { page } = session;
  await connect(page);
  await say(page, 'screenshot nao');
  await expect(page.getByRole('log')).toContainText('স্ক্রিনশট নিয়েছি।', { timeout: 20_000 });

  const step = page.getByRole('region', { name: 'Actions' }).getByRole('listitem');
  // "screenshot nao" is Banglish, so Allaya describes its own action in Bengali.
  await expect(step).toContainText('স্ক্রিনশট নেওয়া হচ্ছে');
  await expect(step).toContainText('Done');
  await expect(step).toContainText('Checked');

  const dir = join(session.userDataDir, 'screenshots');
  expect(existsSync(dir)).toBe(true);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const bytes = readFileSync(join(dir, files[0]!));
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // a real PNG
  expect(bytes.length).toBeGreaterThan(1000); // an actual picture, not an empty placeholder
  // The model was told where it went, and was not sent the image.
  const result = JSON.parse(
    (
      chatRequests()[1]!.body as { messages: Array<{ content: Array<{ content?: string }> }> }
    ).messages.at(-1)!.content[0]!.content!,
  ) as { output: { path: string } };
  expect(result.output.path).toBe(join(dir, files[0]!));
});

test('the model is offered only the tools that work on this machine (and the way to start a task)', async () => {
  ai.turns = [{ text: ['ok'] }];
  const { page } = await start();
  await connect(page);
  await say(page, 'hello');
  await expect(page.getByRole('log')).toContainText('ok');
  const names = (chatRequests()[0]!.body as { tools: Array<{ name: string }> }).tools
    .map((t) => t.name)
    .sort();
  expect(names).toEqual(
    [
      'browser_back',
      'browser_click',
      'browser_close',
      'browser_close_tab',
      'browser_list_tabs',
      'browser_open',
      'browser_press',
      'browser_read',
      'browser_screenshot',
      'browser_switch_tab',
      'browser_type',
      'copy_file',
      'create_folder',
      'delete_file',
      'delete_folder',
      'e2e_probe',
      'find_files',
      'get_datetime',
      'get_file_info',
      'list_file_actions',
      'list_folder',
      'move_file',
      'open_file',
      'read_clipboard',
      'read_file',
      'rename_file',
      'start_task',
      'take_screenshot',
      'undo_file_action',
      'write_clipboard',
      'write_file',
    ].sort(),
  );
});

test('copying text to the clipboard asks first, shows exactly what will be copied, then verifies by reading it back', async () => {
  ai.turns = [
    { calls: [{ id: 'toolu_c', name: 'write_clipboard', input: { text: 'বাংলা text 123' } }] },
    { text: ['কপি করেছি।'] },
  ];
  const { page, app: electron } = await start();
  await connect(page);
  await say(page, 'copy this');
  const dialog = page.getByRole('dialog', { name: 'Confirmation required' });
  await expect(dialog).toContainText('Copy “বাংলা text 123” to the clipboard');
  expect(await electron.evaluate(({ clipboard }) => clipboard.readText())).not.toBe(
    'বাংলা text 123',
  ); // nothing yet
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('log')).toContainText('কপি করেছি।', { timeout: 15_000 });
  expect(await electron.evaluate(({ clipboard }) => clipboard.readText())).toBe('বাংলা text 123');
  await expect(page.getByRole('region', { name: 'Actions' }).getByRole('listitem')).toContainText(
    'Checked',
  );
});

test('reading the clipboard asks first (it may hold passwords)', async () => {
  ai.turns = [
    { calls: [{ id: 'toolu_r', name: 'read_clipboard', input: {} }] },
    { text: ['I read it.'] },
  ];
  const { page, app: electron } = await start();
  await electron.evaluate(({ clipboard }) => clipboard.writeText('private note'));
  await connect(page);
  await say(page, 'what did I copy?');
  const dialog = page.getByRole('dialog', { name: 'Confirmation required' });
  await expect(dialog).toContainText('Read the clipboard');
  expect(chatRequests()).toHaveLength(1); // nothing has been read or sent to the model yet
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('log')).toContainText('I read it.', { timeout: 15_000 });
  const result = JSON.parse(
    (
      chatRequests()[1]!.body as { messages: Array<{ content: Array<{ content?: string }> }> }
    ).messages.at(-1)!.content[0]!.content!,
  ) as { output: { text: string } };
  expect(result.output.text).toBe('private note');
});
