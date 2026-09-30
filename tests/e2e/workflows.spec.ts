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
  sandbox = mkdtempSync(join(tmpdir(), 'allaya-e2e-workflows-'));
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
  await page.evaluate(() =>
    window.allaya.invoke('permissions:set', { subject: 'file_access', mode: 'always_allow' }),
  );
}

const folderStep = (name: string) => [
  { calls: [{ id: `c-${name}`, name: 'create_folder', input: { path: `Documents/${name}` } }] },
  {
    calls: [
      {
        id: `d-${name}`,
        name: 'finish_step',
        input: { outcome: 'done', summary: `Made ${name}.` },
      },
    ],
  },
];

test('build a workflow on the screen — a step, a question for you, another step — and run it', async () => {
  ai.tasks.steps = { s1: [...folderStep('Alpha'), ...folderStep('Beta')] };
  app = await launchApp({
    env: {
      ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }),
      ALLAYA_E2E_FILES_DIR: sandbox,
    },
  });
  const { page } = app;
  await connect(page);
  await nav(page, 'Automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  const form = page.getByRole('dialog', { name: 'New automation' });
  await form.getByLabel('Name').fill('Two folders');
  await form.getByLabel('When should it run?').selectOption({ label: 'Only when I run it' });
  await form.getByRole('radio', { name: 'Several steps' }).click();

  const steps = form.getByTestId('workflow-step');
  await steps
    .nth(0)
    .getByLabel('What should Allaya do?')
    .fill('Create a folder called Alpha in Documents.');
  await form.getByRole('button', { name: 'Ask me first' }).click();
  await steps.nth(1).getByLabel('What should Allaya ask you?').fill('Make the other folder too?');
  await form.getByRole('button', { name: 'Do something' }).last().click();
  await steps
    .nth(2)
    .getByLabel('What should Allaya do?')
    .fill('Create a folder called Beta in Documents.');
  await expect(steps).toHaveCount(3);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();

  const card = page.getByTestId('automation-card');
  await expect(card).toContainText('3 steps');
  await card.getByRole('button', { name: 'Run now' }).click();

  // The first step runs; then the run waits for the person, and says what it asks.
  const ask = card.getByTestId('approval-ask');
  await expect(ask).toContainText('Make the other folder too?', { timeout: 20_000 });
  expect(existsSync(join(docs, 'Alpha'))).toBe(true);
  expect(existsSync(join(docs, 'Beta'))).toBe(false);

  await ask.getByRole('button', { name: 'Approve' }).click();
  await expect(ask).toBeHidden({ timeout: 20_000 });
  await expect.poll(() => existsSync(join(docs, 'Beta')), { timeout: 20_000 }).toBe(true);

  await card.getByRole('button', { name: 'History' }).click();
  await expect(card.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Step 2');
});

test('saying no ends the run, and the step after the question never happens', async () => {
  ai.tasks.steps = { s1: [...folderStep('Alpha'), ...folderStep('Beta')] };
  app = await launchApp({
    env: {
      ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }),
      ALLAYA_E2E_FILES_DIR: sandbox,
    },
  });
  const { page } = app;
  await connect(page);
  await nav(page, 'Automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  const form = page.getByRole('dialog', { name: 'New automation' });
  await form.getByLabel('Name').fill('Ask first');
  await form.getByLabel('When should it run?').selectOption({ label: 'Only when I run it' });
  await form.getByRole('radio', { name: 'Several steps' }).click();
  const steps = form.getByTestId('workflow-step');
  await steps
    .nth(0)
    .getByLabel('What should Allaya do?')
    .fill('Create a folder called Alpha in Documents.');
  await form.getByRole('button', { name: 'Ask me first' }).click();
  await steps.nth(1).getByLabel('What should Allaya ask you?').fill('Go on?');
  await form.getByRole('button', { name: 'Do something' }).last().click();
  await steps
    .nth(2)
    .getByLabel('What should Allaya do?')
    .fill('Create a folder called Beta in Documents.');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();

  const card = page.getByTestId('automation-card');
  await card.getByRole('button', { name: 'Run now' }).click();
  const ask = card.getByTestId('approval-ask');
  await expect(ask).toContainText('Go on?', { timeout: 20_000 });
  await ask.getByRole('button', { name: 'Decline' }).click();
  await expect(ask).toBeHidden({ timeout: 20_000 });
  await card.getByRole('button', { name: 'History' }).click();
  await expect(card).toContainText('You said no');
  expect(existsSync(join(docs, 'Beta'))).toBe(false);
});

test('a problem with the steps is shown on the step, before anything is saved', async () => {
  app = await launchApp({
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) },
  });
  const { page } = app;
  await nav(page, 'Automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  const form = page.getByRole('dialog', { name: 'New automation' });
  await form.getByLabel('Name').fill('Empty');
  await form.getByRole('radio', { name: 'Several steps' }).click();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByTestId('workflow-step').first()).toContainText('Fill this in.');
  await expect(form).toBeVisible();
});
