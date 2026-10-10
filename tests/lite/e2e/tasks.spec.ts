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

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';

const start = async (env: Record<string, string> = {}) =>
  (app = await launchLite({
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }), ...env },
  }));
const chatRequests = () => ai.requests.filter((r) => r.url === '/v1/messages');
const bodyOf = (index: number) =>
  chatRequests()[index]!.body as { model: string; system?: string; messages: unknown[] };
const say = async (page: Page, text: string) => {
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill(text);
  await box.press('Enter');
};

async function connect(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Add a service' }).click();
  await page.getByRole('button', { name: 'Anthropic (Claude)' }).click();
  await page.getByLabel('API key').fill(FakeAi.VALID_KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('“Anthropic (Claude)” connected.')).toBeVisible();
  await page.getByRole('button', { name: 'Back to chat' }).click();
}

const openTasks = (page: Page) => page.getByRole('button', { name: /^Tasks/ }).click();

async function makeTask(
  page: Page,
  options: { name: string; instructions: string; need?: string },
) {
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Name').fill(options.name);
  await page.getByLabel('What should Allaya do?').fill(options.instructions);
  if (options.need) await page.getByRole('button', { name: options.need }).click();
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('heading', { name: options.name })).toBeVisible();
}

test('the person makes a task, chooses a model for it, runs it, and reads its report', async () => {
  ai.reply = () => ['Everything is calm. ', 'No news today.'];
  const { page } = await start();
  await connect(page);
  await openTasks(page);
  await expect(page.getByText('No tasks yet')).toBeVisible();

  await makeTask(page, {
    name: 'Calm check',
    instructions: 'Tell me whether the day is calm.',
    need: 'Fast and cheap',
  });
  // The need chose the small model; the task says so.
  await expect(page.getByText('Claude Haiku 4.5', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Not run yet', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Run now' }).click();
  const report = page.getByTestId('report');
  await expect(report.getByText('Everything is calm. No news today.')).toBeVisible();
  await expect(report.getByText('Done')).toBeVisible();
  await expect(report.getByText(/run by you/)).toBeVisible();

  // What was sent: that model, the task framing, and the instructions as the user's request.
  expect(chatRequests()).toHaveLength(1);
  const sent = bodyOf(0);
  expect(sent.model).toBe(HAIKU);
  expect(sent.system).toContain('carrying out a task');
  expect(sent.system).toContain('“Calm check”');
  expect(JSON.stringify(sent.messages)).toContain('Tell me whether the day is calm.');

  // The list shows how it went; the task is saved across a restart.
  await page.getByRole('button', { name: 'All tasks' }).click();
  const card = page.getByTestId('task');
  await expect(card).toContainText('Calm check');
  await expect(card).toContainText('Done');
});

test('each task uses its own model — and a task without one follows the default', async () => {
  ai.reply = (text) => [`Did: ${text}`];
  const { page } = await start();
  await connect(page);
  await openTasks(page);
  await makeTask(page, { name: 'Small job', instructions: 'job-small', need: 'Fast and cheap' });
  await page.getByRole('button', { name: 'All tasks' }).click();
  await makeTask(page, { name: 'Default job', instructions: 'job-default' });
  await page.getByRole('button', { name: 'All tasks' }).click();
  await makeTask(page, { name: 'Big job', instructions: 'job-big', need: 'Hard thinking' });
  await page.getByRole('button', { name: 'All tasks' }).click();

  for (const name of ['Small job', 'Default job', 'Big job']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByTestId('report').getByText(/^Did: /)).toBeVisible();
    await page.getByRole('button', { name: 'All tasks' }).click();
  }
  const models = Object.fromEntries(
    chatRequests().map((r) => {
      const b = r.body as { model: string; messages: unknown[] };
      return [/job-\w+/.exec(JSON.stringify(b.messages))![0], b.model];
    }),
  );
  expect(models['job-small']).toBe(HAIKU);
  expect(models['job-big']).toBe(SONNET);
  // Nothing was chosen for the third: it uses the first model on offer.
  expect([SONNET, HAIKU]).toContain(models['job-default']);
});

test('a task and its report are still there after the app is closed and opened again', async () => {
  ai.reply = () => ['Report.'];
  const first = await start();
  await connect(first.page);
  await openTasks(first.page);
  await makeTask(first.page, { name: 'Persistent', instructions: 'Do it.' });
  await first.page.getByRole('button', { name: 'Run now' }).click();
  await expect(first.page.getByTestId('report').getByText('Report.')).toBeVisible();
  const userDataDir = first.userDataDir;
  await app!.app.close();

  app = await launchLite({
    userDataDir,
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) },
  });
  await openTasks(app.page);
  await expect(app.page.getByTestId('task')).toContainText('Persistent');
  await expect(app.page.getByTestId('task')).toContainText('Done');
});

test('Allaya proposes a task in a chat and nothing is made until the person allows it', async () => {
  const args = {
    title: 'Headline check',
    instructions: 'Report the headline of the site.',
    when: 'daily',
    time: '08:30',
    days: ['Monday', 'Friday'],
    model_need: 'fast',
  };
  ai.turns = [
    { calls: [{ id: 'toolu_1', name: 'create_task', input: args }] },
    { text: ['No problem, I did not set it up.'] },
    { calls: [{ id: 'toolu_2', name: 'create_task', input: args }] },
    { text: ['Done — it is in your Tasks.'] },
  ];
  const { page } = await start();
  await connect(page);

  // First ask: the person says no.
  await say(page, 'Every Monday and Friday morning check the headline');
  const question = page.getByTestId('approval');
  await expect(question).toContainText(
    'Create the task “Headline check” — Monday, Friday at 08:30',
  );
  await question.getByRole('button', { name: 'Don’t allow' }).click();
  await expect(page.getByText('No problem, I did not set it up.')).toBeVisible();
  await openTasks(page);
  await expect(page.getByText('No tasks yet')).toBeVisible();

  // Second ask: allowed.
  await page.getByRole('button', { name: 'New chat' }).click();
  await say(page, 'Please try again');
  await page.getByTestId('approval').getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Done — it is in your Tasks.')).toBeVisible();
  await openTasks(page);
  const card = page.getByTestId('task');
  await expect(card).toContainText('Headline check');
  await expect(card).toContainText('Mon, Fri at 08:30 · Claude Haiku 4.5');
  await card.getByRole('button', { name: 'Headline check' }).click();
  await expect(page.getByText('Set up by Allaya')).toBeVisible();
});

test('a task set for a time runs by itself at that time, with no one clicking', async () => {
  const soon = new Date(Date.now() + 4000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}:${pad(soon.getSeconds())}`;
  ai.turns = [
    {
      calls: [
        {
          id: 'toolu_1',
          name: 'create_task',
          input: {
            title: 'Alarm',
            instructions: 'Say good morning.',
            when: 'once',
            at,
            use_browser: false,
          },
        },
      ],
    },
    { text: ['Scheduled.'] },
    { text: ['Good morning from the schedule.'] },
  ];
  const { page } = await start({ ALLAYA_E2E_TICK_MS: '500' });
  await connect(page);
  await say(page, 'Remind me in a few seconds');
  await page.getByTestId('approval').getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page.getByText('Scheduled.')).toBeVisible();
  await openTasks(page);
  const card = page.getByTestId('task');
  await expect(card).toContainText('Alarm');
  // It runs on its own, once.
  await expect(card).toContainText('Done', { timeout: 20_000 });
  await card.getByRole('button', { name: 'Alarm' }).click();
  await expect(page.getByTestId('report')).toContainText('Good morning from the schedule.');
  await expect(page.getByTestId('report')).toContainText('on schedule');
  // Done for good: it says there is no next run, and nothing asked the model again.
  await expect(page.getByText('No more runs')).toBeVisible();
  expect(chatRequests()).toHaveLength(3);
});

test('a task cannot make more tasks, and cannot use tools it was not given', async () => {
  ai.turns = [
    { calls: [{ id: 'toolu_1', name: 'create_task', input: { title: 'x', instructions: 'y' } }] },
    { text: ['I could not.'] },
  ];
  const { page } = await start();
  await connect(page);
  await openTasks(page);
  await makeTask(page, { name: 'Sneaky', instructions: 'Make another task.' });
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByTestId('report').getByText('I could not.')).toBeVisible();
  const tools = (bodyOf(0) as unknown as { tools?: Array<{ name: string }> }).tools ?? [];
  expect(tools.map((t) => t.name)).not.toContain('create_task');
  await expect(page.getByTestId('approval')).toHaveCount(0);
});

test('the Bengali screen has the same tasks, in Bengali', async () => {
  const { page } = await start();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByLabel('Language').selectOption('bn');
  await page.getByRole('button', { name: /^(Back to chat|চ্যাটে ফিরুন)$/ }).click();
  await page.getByRole('button', { name: /^কাজ/ }).click();
  await expect(page.getByRole('heading', { name: 'কাজ' })).toBeVisible();
  await expect(page.getByText('এখনো কোনো কাজ নেই')).toBeVisible();
  await page.getByRole('button', { name: 'নতুন কাজ' }).click();
  await expect(page.getByLabel('আলেয়া কী করবে?')).toBeVisible();
});

test('closing the window keeps Allaya running in the tray, so scheduled tasks still run — until it is quit', async () => {
  const { app: electron, page } = await start({ ALLAYA_E2E_TRAY: '1' });
  const state = () =>
    electron.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      return window ? { visible: window.isVisible(), destroyed: window.isDestroyed() } : null;
    });
  await expect.poll(state).toEqual({ visible: true, destroyed: false });
  // The close button hides the window; the app (and its clock) goes on.
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(state).toEqual({ visible: false, destroyed: false });
  expect(page.isClosed()).toBe(false);
  // Opened again from the tray, it is the same window.
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
  await expect.poll(state).toEqual({ visible: true, destroyed: false });
});

test('with "keep running" turned off, closing the window ends the app', async () => {
  const { app: electron, page } = await start({ ALLAYA_E2E_TRAY: '1' });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).click();
  await page
    .getByRole('switch', { name: /Keep running in the tray when I close the window/ })
    .uncheck();
  await expect(page.getByText('Saved.')).toBeVisible();
  const closed = new Promise<void>((resolve) => electron.process().once('exit', () => resolve()));
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await closed;
});
