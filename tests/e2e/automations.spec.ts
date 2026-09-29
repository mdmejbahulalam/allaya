import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  sandbox = mkdtempSync(join(tmpdir(), 'allaya-e2e-automations-'));
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
const cards = (page: Page) => page.getByTestId('automation-card');
const automationCount = (page: Page) =>
  page.evaluate(async () => {
    const reply = await window.allaya.invoke('automations:list');
    return reply.ok ? reply.data.automations.length : -1;
  });

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

/** Fills in the "New automation" dialog and saves it. Every-30-minutes is the form's default for "Every so often". */
async function createAutomation(
  page: Page,
  name: string,
  instruction: string,
  when: 'Only when I run it' | 'Every so often',
) {
  await nav(page, 'Automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  const form = page.getByRole('dialog', { name: 'New automation' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('What should Allaya do?').fill(instruction);
  await form.getByLabel('When should it run?').selectOption({ label: when });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
}

const INSTRUCTION = 'Create a folder called Nightly in Documents.';
const finishStep = (id: string, summary: string) => ({
  calls: [{ id, name: 'finish_step', input: { outcome: 'done', summary } }],
});
const scriptFolderRun = () => {
  ai.tasks.steps = {
    s1: [
      { calls: [{ id: 'a1', name: 'create_folder', input: { path: 'Documents/Nightly' } }] },
      finishStep('a2', 'Created the Nightly folder.'),
    ],
  };
};

test('an automation made on the screen runs as an ordinary task, and its history says so', async () => {
  scriptFolderRun();
  const { page } = await start();
  await connect(page);
  await nav(page, 'Automations');
  await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
  await expect(page.getByText('No automations yet.')).toBeVisible();

  await createAutomation(page, 'Nightly folder', INSTRUCTION, 'Only when I run it');
  await expect(cards(page)).toHaveCount(1);
  const card = cards(page).first();
  await expect(card.getByRole('heading', { name: 'Nightly folder' })).toBeVisible();
  await expect(card).toContainText('Only when you run it');
  await expect(card).toContainText('Has not run yet');
  // Nothing happens just because it was created.
  expect(existsSync(join(docs, 'Nightly'))).toBe(false);

  await card.getByRole('button', { name: 'Run now' }).click();
  await expect.poll(() => existsSync(join(docs, 'Nightly')), { timeout: 30_000 }).toBe(true);
  await expect(card.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  await card.getByRole('button', { name: 'History' }).click();
  await expect(card.getByText('By you')).toBeVisible();

  // The run is a real task, listed under "Scheduled", and it opens from the history.
  await nav(page, 'Tasks');
  await page.getByRole('tab', { name: /Scheduled/ }).click();
  await expect(page.getByRole('list', { name: 'Tasks' })).toContainText('Nightly folder');
  await nav(page, 'Automations');
  await cards(page).first().getByRole('button', { name: 'History' }).click();
  await cards(page).first().getByRole('button', { name: 'Open task' }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  await expect(page.getByTestId('task-detail')).toContainText('Created the Nightly folder.');
});

test('the form refuses what cannot work before it reaches the backend', async () => {
  const { page } = await start();
  await nav(page, 'Automations');
  await page.getByRole('button', { name: 'Create Automation' }).click();
  const form = page.getByRole('dialog', { name: 'New automation' });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Give it a name.')).toBeVisible();
  await expect(form.getByText('Say what Allaya should do.')).toBeVisible();

  await form.getByLabel('Name').fill('Too often');
  await form.getByLabel('What should Allaya do?').fill('List Downloads');
  await form.getByLabel('When should it run?').selectOption({ label: 'Every so often' });
  await form.getByRole('spinbutton').fill('2');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('At least 5 minutes apart.')).toBeVisible();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('No automations yet.')).toBeVisible();
});

test('STOP ends a run in progress and pauses every schedule until you turn them back on', async () => {
  ai.tasks.steps = { s1: ['hang'] };
  const first = await start();
  const { page } = first;
  await connect(page);
  await createAutomation(page, 'Slow one', INSTRUCTION, 'Every so often');
  await cards(page).first().getByRole('button', { name: 'Run now' }).click();

  // The run is working, so the emergency stop is on offer.
  const stop = page.getByRole('button', { name: 'STOP' });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();
  await expect(page.getByText('Stopped', { exact: true }).first()).toBeVisible();
  expect(existsSync(join(docs, 'Nightly'))).toBe(false);

  await expect(page.getByText('Automations are paused')).toBeVisible();
  await cards(page).first().getByRole('button', { name: 'History' }).click();
  await expect(cards(page).first().getByText('Stopped', { exact: true }).first()).toBeVisible();

  // The pause is remembered: it survives closing and opening Allaya.
  const userDataDir = first.userDataDir;
  await first.app.close();
  app = undefined;
  const second = await start(userDataDir);
  await nav(second.page, 'Automations');
  await expect(second.page.getByText('Automations are paused')).toBeVisible();
  await expect(cards(second.page)).toHaveCount(1);

  await second.page.getByRole('button', { name: 'Turn automations back on' }).click();
  await expect(second.page.getByText('Automations are paused')).toBeHidden();
  await second.close();
  app = undefined;
  rmSync(userDataDir, { recursive: true, force: true });
});

test('the model can offer an automation, but only a click on the screen creates it — and it is remembered', async () => {
  ai.turns = [
    {
      calls: [
        {
          id: 'ca',
          name: 'create_automation',
          input: {
            name: 'Weekday Downloads check',
            instruction: 'List what is new in my Downloads folder and tell me.',
            trigger: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
          },
        },
      ],
    },
    { text: ['That is set up.'] },
  ];
  const first = await start();
  const { page } = first;
  await connect(page);
  await nav(page, 'Chat');
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill('Every weekday at 9 check my Downloads folder for me.');
  await box.press('Enter');

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('Critical');
  await expect(dialog(page)).toContainText('Weekday Downloads check');
  await expect(dialog(page)).toContainText('List what is new in my Downloads folder');
  // Nothing exists until the click.
  expect(await automationCount(page)).toBe(0);
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('log')).toContainText('That is set up.');
  expect(await automationCount(page)).toBe(1);

  await nav(page, 'Automations');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('Weekday Downloads check');
  await expect(cards(page).first()).toContainText('Weekdays at');
  await expect(cards(page).first()).toContainText('Next run:');

  const userDataDir = first.userDataDir;
  await first.app.close();
  app = undefined;
  const second = await start(userDataDir);
  await nav(second.page, 'Automations');
  await expect(cards(second.page)).toHaveCount(1);
  await expect(cards(second.page).first()).toContainText('Weekday Downloads check');
  await expect(cards(second.page).first()).toContainText('Next run:');

  // Deleting asks first, and removes it.
  await cards(second.page).first().getByRole('button', { name: 'Delete automation' }).click();
  await second.page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(second.page.getByText('No automations yet.')).toBeVisible();
  await second.close();
  app = undefined;
  rmSync(userDataDir, { recursive: true, force: true });
});
