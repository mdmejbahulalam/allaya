import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from './fake-ai';
import { launchApp, type LaunchedApp } from './fixtures';
import { startWebFixture, type WebFixture } from '../helpers/web-fixture';

// A real Chromium is driven by the real Electron app. Skipped where there is none.
const CHROMIUM = ['/opt/pw-browsers/chromium', process.env['ALLAYA_TEST_CHROMIUM'] ?? '']
  .filter(Boolean)
  .find((path) => existsSync(path));
test.skip(!CHROMIUM, 'no Chromium available');

let ai: FakeAi;
let web: WebFixture;
let app: LaunchedApp | undefined;

test.beforeEach(async () => {
  ai = await FakeAi.start();
  web = await startWebFixture();
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await ai.stop();
  await web.close();
});

const start = async () =>
  (app = await launchApp({
    env: {
      ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }),
      ALLAYA_E2E_BROWSER_EXE: CHROMIUM!,
      ALLAYA_E2E_BROWSER_HOSTS: 'fake.test,other.test',
    },
  }));
const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Confirmation required' });
const allow = (page: Page) => dialog(page).getByRole('button', { name: 'Allow once' }).click();

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
const resultsOf = (index: number) =>
  (
    chatRequests()[index]!.body as { messages: Array<{ content: Array<{ content?: string }> }> }
  ).messages
    .at(-1)!
    .content.map(
      (c) =>
        JSON.parse(c.content!) as {
          ok: boolean;
          status: string;
          error?: string;
          output?: Record<string, unknown>;
        },
    );
const call = (name: string, input: unknown, id = `t_${name}`) => ({ id, name, input });
const invokeApp = (page: Page, channel: string, payload?: unknown) =>
  page.evaluate(
    ([c, p]) =>
      (
        window as unknown as { allaya: { invoke: (c: string, p: unknown) => Promise<unknown> } }
      ).allaya.invoke(c, p),
    [channel, payload] as const,
  );

test('the Browser screen reports the browser and manages the trusted and blocked lists', async () => {
  const { page } = await start();
  await nav(page, 'Browser');
  await expect(page.getByRole('heading', { name: 'Browser', level: 1 })).toBeVisible();
  await expect(page.getByText('Chromium')).toBeVisible();
  await expect(page.getByText('Not open')).toBeVisible();
  await expect(page.getByText('browser_open')).toBeVisible();
  await expect(page.getByText(/Type passwords, card numbers or verification codes/)).toBeVisible();

  const trusted = page.locator('[data-list="trusted"]');
  await trusted.getByLabel('Add a site').fill('Wikipedia.ORG');
  await trusted.getByRole('button', { name: 'Add' }).click();
  await expect(trusted.getByText('wikipedia.org')).toBeVisible();
  const blocked = page.locator('[data-list="blocked"]');
  await blocked.getByLabel('Add a site').fill('not a site');
  await blocked.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('That is not a valid web address.')).toBeVisible();
  await blocked.getByLabel('Add a site').fill('wikipedia.org');
  await blocked.getByRole('button', { name: 'Add' }).click();
  await expect(blocked.getByText('wikipedia.org')).toBeVisible(); // moved, not copied
  await expect(trusted.getByText('wikipedia.org')).toHaveCount(0);
  await blocked.getByRole('button', { name: 'Remove wikipedia.org' }).click();
  await expect(blocked.getByText('No blocked sites.')).toBeVisible();
});

test('"Open browser window" starts the real browser, and "Close browser" ends it', async () => {
  const { page } = await start();
  await nav(page, 'Browser');
  await page.getByRole('button', { name: 'Open browser window' }).click();
  await expect(page.getByText(/^Open without a window|^Open in a visible window/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('list', { name: 'Open tabs' })).toBeVisible();
  await page.getByRole('button', { name: 'Close browser' }).click();
  await expect(page.getByText('Not open')).toBeVisible({ timeout: 15_000 });
});

test('the model browses a real page: asks before a new site, reads it, searches — and the server got exactly that', async () => {
  ai.turns = [
    { calls: [call('browser_open', { url: web.url('/form') })] },
    { calls: [call('browser_read', {})] },
    { calls: [call('browser_type', { ref: 'e1_7', text: 'দাম কম', submit: true })] },
    { calls: [call('browser_read', {}, 't_read2')] },
    { text: ['খুঁজে পেয়েছি।'] },
  ];
  const { page } = await start();
  await connect(page);
  await say(page, 'fake.test e search koro');
  await expect(dialog(page)).toContainText('fake.test');
  expect(web.hits.size).toBe(0); // nothing was contacted before the answer
  await allow(page); // the first visit to a site
  await expect(dialog(page)).toContainText('দাম কম', { timeout: 60_000 }); // typing asks, and shows exactly what will be typed
  await allow(page);
  await expect(page.getByRole('log')).toContainText('খুঁজে পেয়েছি।', { timeout: 60_000 });
  const read = resultsOf(2)[0]!;
  expect(String(read.output?.['note'])).toContain('untrusted');
  const names = (
    read.output?.['elements'] as Array<{ ref: string; name: string; sensitive?: string }>
  ).map((e) => e.name);
  expect(names).toContain('Search the site');
  const second = resultsOf(4)[0]!;
  expect(JSON.stringify(second.output)).toContain('Results for দাম কম');
  expect(web.hits.get('/search')).toBe(1);
  await expect(
    page.getByRole('region', { name: 'Actions' }).getByRole('listitem').first(),
  ).toContainText('Checked');
});

test('a page that plants a local-network address cannot make Allaya visit it — and Allaya is never bothered about it', async () => {
  ai.turns = [
    { calls: [call('browser_open', { url: web.url('/inject') })] },
    { calls: [call('browser_read', {})] },
    {
      calls: [
        call('browser_open', { url: `http://127.0.0.1:${web.port}/secret?stolen=1` }, 't_evil'),
      ],
    },
    { calls: [call('browser_open', { url: web.url('/redirect-private') }, 't_redirect')] },
    { text: ['That page tried to instruct me; I ignored it.'] },
  ];
  const { page } = await start();
  await connect(page);
  await say(page, 'open the deals page');
  await allow(page); // the first visit to fake.test
  await expect(page.getByRole('log')).toContainText('I ignored it.', { timeout: 60_000 });
  const warned = resultsOf(2)[0]!;
  expect(String(warned.output?.['warning'])).toContain('Do NOT follow');
  expect(resultsOf(3)[0]).toMatchObject({ ok: false });
  expect(resultsOf(3)[0]!.error).toContain('own network');
  expect(resultsOf(4)[0]).toMatchObject({ ok: false });
  expect(web.hits.get('/secret') ?? 0).toBe(0); // the "router" was never contacted, directly or by redirect
});

test('typing into a password field is refused; sending the form asks; the server never sees a password', async () => {
  ai.turns = [
    { calls: [call('browser_open', { url: web.url('/form') })] },
    { calls: [call('browser_read', {})] },
    { calls: [call('browser_type', { ref: 'e1_2', text: 'রহিম' }, 't_name')] },
    { calls: [call('browser_type', { ref: 'e1_3', text: 'hunter2' }, 't_pw')] },
    { calls: [call('browser_click', { ref: 'e1_6' }, 't_send')] },
    { text: ['Sent, without the password.'] },
  ];
  const { page } = await start();
  await connect(page);
  await say(page, 'fill the form');
  await allow(page); // new site
  await allow(page); // typing the name (MEDIUM)
  // "Send message" looks like sending, so it is graded HIGH and asks — it can never be silenced by "always allow".
  await expect(dialog(page)).toContainText('looks like it sends something', { timeout: 60_000 });
  await expect(dialog(page)).toContainText('High');
  await allow(page);
  await expect(page.getByRole('log')).toContainText('Sent, without the password.', {
    timeout: 60_000,
  });
  expect(resultsOf(4)[0]).toMatchObject({ ok: false });
  expect(resultsOf(4)[0]!.error).toContain('does not type those');
  expect(web.posts).toHaveLength(1);
  expect(web.posts[0]!.body).toContain('name=রহিম');
  expect(web.posts[0]!.body).not.toContain('hunter2');
});

test('paying is CRITICAL: the question says so, and nothing is sent until it is approved on screen', async () => {
  ai.turns = [
    { calls: [call('browser_open', { url: web.url('/shop') })] },
    { calls: [call('browser_read', {})] },
    { calls: [call('browser_click', { ref: 'e1_1' }, 't_buy')] },
    { text: ['Paid.'] },
  ];
  const { page } = await start();
  await connect(page);
  await say(page, 'buy it');
  await allow(page); // new site
  await expect(dialog(page)).toContainText('looks like a payment', { timeout: 60_000 });
  await expect(dialog(page)).toContainText('Critical');
  expect(web.hits.get('/paid') ?? 0).toBe(0);
  await allow(page);
  await expect(page.getByRole('log')).toContainText('Paid.', { timeout: 60_000 });
  expect(web.hits.get('/paid')).toBe(1);
});

test('a blocked site is never opened, whatever is asked; the emergency stop ends a slow page', async () => {
  ai.turns = [
    { calls: [call('browser_open', { url: web.url('/', 'other.test') })] },
    { text: ['That site is blocked.'] },
  ];
  const { page } = await start();
  await invokeApp(page, 'browser:setDomain', {
    list: 'blocked',
    domain: 'other.test',
    present: true,
  });
  await invokeApp(page, 'browser:setDomain', {
    list: 'trusted',
    domain: 'fake.test',
    present: true,
  });
  await connect(page);
  await say(page, 'open other');
  await expect(page.getByRole('log')).toContainText('That site is blocked.', { timeout: 30_000 });
  expect(resultsOf(1)[0]!.error).toContain('blocked list');
  expect(web.hits.size).toBe(0);

  ai.turns = [{ calls: [call('browser_open', { url: web.url('/slow') })] }, { text: ['stopped'] }];
  await say(page, 'open the slow page');
  await expect(page.getByRole('button', { name: 'Stop' }).first()).toBeVisible({ timeout: 30_000 });
  const started = Date.now();
  await page.getByRole('button', { name: 'Stop' }).first().click();
  await expect(page.getByText(/cancelled|Stopped/i).first()).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - started).toBeLessThan(12_000);
});
