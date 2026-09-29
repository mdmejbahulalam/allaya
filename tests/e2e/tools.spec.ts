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

const probe = (level: string, note: string) => ({
  id: `toolu_${level}`,
  name: 'e2e_probe',
  input: { level, note },
});
const say = async (page: Page, text: string) => {
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill(text);
  await box.press('Enter');
};
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Confirmation required' });
const chatRequests = () => ai.requests.filter((r) => r.url === '/v1/messages');

test('a risky action waits for an explicit "Allow once", then runs and reports what was checked', async () => {
  ai.turns = [
    { text: ['I will tidy up. '], calls: [probe('MEDIUM', 'tidy the desktop')] },
    { text: ['All tidy.'] },
  ];
  const { page } = await start();
  await connect(page);
  await say(page, 'tidy my desktop');

  const confirm = dialog(page);
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Probe (MEDIUM): tidy the desktop');
  await expect(confirm).toContainText('Medium risk');
  // Safe defaults: focus starts on the refusal, not the approval.
  await expect(confirm.getByRole('button', { name: "Don't allow" })).toBeFocused();
  // Nothing has run yet, and the model has not been told anything happened.
  expect(chatRequests()).toHaveLength(1);
  await expect(page.locator('[data-status="awaiting_confirmation"]')).toContainText(
    'Waiting for you',
  );

  await confirm.getByRole('button', { name: 'Allow once' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole('log')).toContainText('All tidy.');
  const step = page.getByRole('region', { name: 'Actions' }).getByRole('listitem');
  await expect(step).toContainText('Probe (MEDIUM): tidy the desktop');
  await expect(step).toContainText('Done');
  await expect(step).toContainText('Checked'); // the effect was verified, not merely reported
  await expect(step).toContainText('Medium risk');
  // The tool result the model saw says the same thing.
  const result = JSON.parse(
    (
      chatRequests()[1]!.body as { messages: Array<{ content: Array<{ content?: string }> }> }
    ).messages.at(-1)!.content[0]!.content!,
  ) as { ok: boolean; verification: string };
  expect(result).toMatchObject({ ok: true, verification: 'verified' });
});

test('declining — by button or Escape — means it never runs and the model is told to respect that', async () => {
  ai.turns = [{ calls: [probe('HIGH', 'first')] }, { text: ['Understood, I will not.'] }];
  const { page } = await start();
  await connect(page);
  await say(page, 'do the risky thing');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('log')).toContainText('Understood, I will not.');
  await expect(page.getByRole('region', { name: 'Actions' }).getByRole('listitem')).toContainText(
    'You said no',
  );
  const result = JSON.parse(
    (
      chatRequests()[1]!.body as { messages: Array<{ content: Array<{ content?: string }> }> }
    ).messages.at(-1)!.content[0]!.content!,
  ) as { status: string; note: string };
  expect(result.status).toBe('rejected');
  expect(result.note).toMatch(/Do not try it again/);
});

test('a spoken "yes" approves a HIGH action; a CRITICAL one insists on the button', async () => {
  ai.turns = [{ calls: [probe('HIGH', 'spoken yes')] }, { text: ['Done speaking.'] }];
  const { page } = await start();
  await connect(page);
  await say(page, 'go');
  await expect(dialog(page)).toContainText('answer by voice');
  // The dialog makes the window inert, so a spoken answer reaches the backend the way the voice feature sends it.
  const speak = (text: string) =>
    page.evaluate(async (t) => {
      const conversations = await window.allaya.invoke('chat:listConversations');
      const active = conversations.ok ? conversations.data[0] : undefined;
      return window.allaya.invoke('chat:send', {
        text: t,
        source: 'voice',
        ...(active ? { conversationId: active.id } : {}),
      });
    }, text);
  const reply = await speak('yes');
  expect(reply).toMatchObject({
    ok: true,
    data: { assistantMessage: { content: 'Okay, going ahead.' } },
  });
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('log')).toContainText('Done speaking.');

  // A critical action: a spoken approval is refused, the on-screen button is required.
  ai.turns = [
    { calls: [probe('CRITICAL', 'dangerous')] },
    { text: ['Finished the dangerous thing.'] },
  ];
  await say(page, 'go again');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('Critical risk');
  await expect(dialog(page)).toContainText('confirmed here on the screen');
  const refused = await speak('yes');
  expect(refused).toMatchObject({
    ok: true,
    data: { assistantMessage: { content: expect.stringContaining('confirmed on the screen') } },
  });
  await expect(dialog(page)).toBeVisible(); // still waiting
  await dialog(page).getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('log')).toContainText('Finished the dangerous thing.');
});

test('"Stop everything" in the dialog — like the emergency stop — cancels the action and the reply', async () => {
  ai.turns = [{ calls: [probe('MEDIUM', 'never happens')] }, { text: ['should not appear'] }];
  const { page } = await start();
  await connect(page);
  await say(page, 'go');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stop everything' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('log').getByText('Stopped', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('log')).not.toContainText('should not appear');
  expect(chatRequests()).toHaveLength(1); // the model never heard back
});

test('a stop that comes from outside the window (e.g. a global hotkey) also closes the question', async () => {
  ai.turns = [{ calls: [probe('HIGH', 'x')] }, { text: ['should not appear'] }];
  const { page } = await start();
  await connect(page);
  await say(page, 'go');
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(() => window.allaya.invoke('agent:stop'));
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('log')).not.toContainText('should not appear');
});

test('a permission set to "never" refuses even a harmless action, without asking', async () => {
  ai.turns = [{ calls: [probe('LOW', 'blocked')] }, { text: ['I am not allowed to do that.'] }];
  const { page } = await start();
  await connect(page);
  await page.evaluate(() =>
    window.allaya.invoke('permissions:set', { subject: 'file_access', mode: 'never' }),
  );
  await say(page, 'go');
  await expect(page.getByRole('log')).toContainText('I am not allowed to do that.');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('region', { name: 'Actions' }).getByRole('listitem')).toContainText(
    'Not allowed',
  );
});

test('LOW-risk actions run without any question', async () => {
  ai.turns = [
    { calls: [{ id: 'toolu_t', name: 'get_datetime', input: {} }] },
    { text: ['It is now.'] },
  ];
  const { page } = await start();
  await connect(page);
  await say(page, 'what time is it?');
  await expect(page.getByRole('log')).toContainText('It is now.');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('region', { name: 'Actions' }).getByRole('listitem')).toContainText(
    'Checking the current date and time',
  );
});

test('the confirmation is localised, and shows Bengali digits and wording when the UI is Bengali', async () => {
  ai.turns = [{ calls: [probe('MEDIUM', 'বাংলা নোট')] }, { text: ['হয়ে গেছে।'] }];
  const { page } = await start();
  await connect(page);
  await say(page, 'কাজটা করো');
  await expect(dialog(page)).toBeVisible();
  // Switch the interface language while the question is open: it re-renders in Bengali.
  await page.evaluate(() =>
    window.allaya.invoke('settings:set', { key: 'language.ui', value: 'bn' }),
  );
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('পরীক্ষা (MEDIUM): বাংলা নোট'); // the tool describes itself in the reply language
  await expect(confirm.getByRole('button', { name: 'অনুমতি দেবেন না' })).toBeFocused();
  await confirm.getByRole('button', { name: 'একবার অনুমতি দিন' }).click();
  await expect(page.getByRole('log')).toContainText('হয়ে গেছে।');
  await expect(page.getByRole('log')).toContainText('যাচাই হয়েছে');
});
