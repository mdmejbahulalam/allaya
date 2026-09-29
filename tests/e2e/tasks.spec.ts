import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from './fake-ai';
import { launchApp, type LaunchedApp } from './fixtures';

let ai: FakeAi;
let app: LaunchedApp | undefined;
let sandbox: string;
let docs: string;

test.beforeEach(async () => {
  ai = await FakeAi.start();
  sandbox = mkdtempSync(join(tmpdir(), 'allaya-e2e-tasks-'));
  docs = join(sandbox, 'Documents');
  for (const dir of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music']) {
    mkdirSync(join(sandbox, dir), { recursive: true });
  }
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await ai.stop();
  rmSync(sandbox, { recursive: true, force: true });
});

const env = () => ({
  ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }),
  ALLAYA_E2E_FILES_DIR: sandbox,
});
const start = async (userDataDir?: string) =>
  (app = await launchApp({ ...(userDataDir ? { userDataDir } : {}), env: env() }));
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Confirmation required' });
const detail = (page: Page) => page.getByTestId('task-detail');

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

const REQUEST = 'First create a folder called Reports in Documents, then save a note in it.';
const plan = (id = 'p1') => ({
  calls: [
    {
      id,
      name: 'submit_plan',
      input: {
        summary: 'Make the folder and save the note',
        steps: [
          { id: 's1', title: 'Create the Reports folder', tool: 'create_folder' },
          {
            id: 's2',
            title: 'Save the note',
            tool: 'write_file',
            dependsOn: ['s1'],
            expected: 'Documents/Reports/note.txt exists',
          },
        ],
        successCriteria: 'The note is in Documents/Reports',
      },
    },
  ],
});
const stepDone = (id: string, summary: string) => ({
  calls: [{ id, name: 'finish_step', input: { outcome: 'done', summary } }],
});
const scriptHappyPath = () => {
  ai.tasks.plan = [plan()];
  ai.tasks.steps = {
    s1: [
      { calls: [{ id: 'a1', name: 'create_folder', input: { path: 'Documents/Reports' } }] },
      stepDone('a2', 'Created the Reports folder.'),
    ],
    s2: [
      {
        calls: [
          {
            id: 'b1',
            name: 'write_file',
            input: { path: 'Documents/Reports/note.txt', content: 'হ্যালো from a task' },
          },
        ],
      },
      stepDone('b2', 'Saved note.txt.'),
    ],
  };
  ai.tasks.summary = [
    {
      calls: [
        {
          id: 'c1',
          name: 'finish_task',
          input: { outcome: 'achieved', summary: 'I made the Reports folder and saved your note.' },
        },
      ],
    },
  ];
};

test('a task is planned, shown for approval, run with one confirmation, and its result is verified', async () => {
  scriptHappyPath();
  const { page } = await start();
  await connect(page);
  await nav(page, 'Tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  await expect(page.getByText('No tasks yet.')).toBeVisible();

  await page.getByRole('textbox', { name: 'New task' }).fill(REQUEST);
  await page.getByRole('switch', { name: 'Show me the plan before starting' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();

  // The plan is shown first and nothing has happened.
  await expect(detail(page).getByText('Review the plan')).toBeVisible();
  await expect(detail(page).getByText('You asked to see the plan first')).toBeVisible();
  await expect(detail(page).getByText('Create the Reports folder')).toBeVisible();
  await expect(page.getByTestId('tasks-waiting')).toContainText('1');
  expect(existsSync(join(docs, 'Reports'))).toBe(false);

  await detail(page).getByRole('button', { name: 'Approve plan' }).click();
  // The folder needs no question (harmless); saving the note does — approving the plan did not approve that.
  await expect(dialog(page)).toContainText('note.txt');
  expect(existsSync(join(docs, 'Reports'))).toBe(true);
  expect(existsSync(join(docs, 'Reports', 'note.txt'))).toBe(false);
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();

  await expect(
    detail(page).getByText('I made the Reports folder and saved your note.'),
  ).toBeVisible();
  await expect(detail(page).getByText('Completed', { exact: true }).first()).toBeVisible();
  expect(readFileSync(join(docs, 'Reports', 'note.txt'), 'utf8')).toBe('হ্যালো from a task');
  await expect(page.getByTestId('tasks-waiting')).toHaveCount(0);

  // What was reported and what was checked are both on the record.
  await detail(page).getByRole('button', { name: 'Details' }).first().click();
  await expect(detail(page).getByText(/What was checked/)).toBeVisible();
  await detail(page).getByText('Activity').click();
  await expect(detail(page).getByText('You approved the plan')).toBeVisible();
  await expect(detail(page).getByText('Results checked')).toBeVisible();

  // Home shows it as a recent task.
  await nav(page, 'Home');
  await expect(page.getByRole('heading', { name: 'Recent tasks' })).toBeVisible();
  await expect(page.getByRole('heading', { name: REQUEST })).toBeVisible();
});

test('rejecting the plan leaves the computer untouched', async () => {
  scriptHappyPath();
  const { page } = await start();
  await connect(page);
  await nav(page, 'Tasks');
  await page.getByRole('textbox', { name: 'New task' }).fill(REQUEST);
  await page.getByRole('switch', { name: 'Show me the plan before starting' }).click();
  await page.getByRole('button', { name: 'Start task' }).click();
  await detail(page).getByRole('button', { name: "Don't do it" }).click();
  await expect(detail(page).getByText('Cancelled', { exact: true }).first()).toBeVisible();
  expect(existsSync(join(docs, 'Reports'))).toBe(false);
});

test('a task started from chat reports back in the conversation and opens from there', async () => {
  scriptHappyPath();
  ai.turns = [
    { calls: [{ id: 'st', name: 'start_task', input: { request: REQUEST } }] },
    { text: ['I started that task for you.'] },
  ];
  const { page } = await start();
  await connect(page);
  await nav(page, 'Chat');
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill(REQUEST);
  await box.press('Enter');
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText('I started that task for you.')).toBeVisible();
  await expect(dialog(page)).toContainText('note.txt');
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  await expect(log.getByText('I made the Reports folder and saved your note.')).toBeVisible();
  expect(existsSync(join(docs, 'Reports', 'note.txt'))).toBe(true);
  await page.getByRole('button', { name: 'Open task' }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  await expect(detail(page).getByText('Make the folder and save the note')).toBeVisible();
});

test('STOP cancels a task that is waiting on the model, and nothing else happens', async () => {
  ai.tasks.plan = ['hang'];
  const { page } = await start();
  await connect(page);
  await nav(page, 'Tasks');
  await page.getByRole('textbox', { name: 'New task' }).fill(REQUEST);
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(detail(page).getByRole('button', { name: 'Stop' })).toBeVisible();
  await detail(page).getByRole('button', { name: 'Stop' }).click();
  await expect(detail(page).getByText('Cancelled', { exact: true }).first()).toBeVisible();
  expect(existsSync(join(docs, 'Reports'))).toBe(false);
});

test('a task interrupted by closing Allaya is still there next time, and resumes only when asked', async () => {
  ai.tasks.plan = [plan()];
  ai.tasks.steps = {
    s1: [
      { calls: [{ id: 'a1', name: 'create_folder', input: { path: 'Documents/Reports' } }] },
      stepDone('a2', 'Created the Reports folder.'),
    ],
    s2: ['hang'],
  };
  const first = await start();
  await connect(first.page);
  await nav(first.page, 'Tasks');
  await first.page.getByRole('textbox', { name: 'New task' }).fill(REQUEST);
  await first.page.getByRole('button', { name: 'Start task' }).click();
  await expect(detail(first.page).getByText('Create the Reports folder').first()).toBeVisible();
  await expect.poll(() => existsSync(join(docs, 'Reports'))).toBe(true);
  // Wait until the second step is waiting on the model, then quit.
  await expect.poll(() => ai.requests.length, { timeout: 15_000 }).toBeGreaterThan(4);
  const userDataDir = first.userDataDir;
  await first.app.close();
  app = undefined;

  // Next session: same profile, and a model that would now finish the job.
  ai.tasks.steps = {
    s2: [
      {
        calls: [
          {
            id: 'b1',
            name: 'write_file',
            input: { path: 'Documents/Reports/note.txt', content: 'after restart' },
          },
        ],
      },
      stepDone('b2', 'Saved note.txt.'),
    ],
  };
  ai.tasks.summary = [
    {
      calls: [
        {
          id: 'c1',
          name: 'finish_task',
          input: { outcome: 'achieved', summary: 'Finished after the restart.' },
        },
      ],
    },
  ];
  const second = await start(userDataDir);
  await nav(second.page, 'Tasks');
  await second.page.getByRole('list', { name: 'Tasks' }).getByRole('button').first().click();
  await expect(
    detail(second.page).getByText('Allaya was closed while this was running'),
  ).toBeVisible();
  // Nothing has run by itself.
  expect(existsSync(join(docs, 'Reports', 'note.txt'))).toBe(false);
  await detail(second.page).getByRole('button', { name: 'Resume' }).click();
  await expect(dialog(second.page)).toContainText('note.txt');
  await dialog(second.page).getByRole('button', { name: 'Allow once' }).click();
  await expect(detail(second.page).getByText('Finished after the restart.')).toBeVisible();
  expect(readFileSync(join(docs, 'Reports', 'note.txt'), 'utf8')).toBe('after restart');
  await second.close();
  app = undefined;
  rmSync(userDataDir, { recursive: true, force: true });
});
