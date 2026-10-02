import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from './fake-ai';
import { launchApp, type LaunchedApp } from './fixtures';

let ai: FakeAi;
let app: LaunchedApp | undefined;
let dir: string;
test.beforeEach(async () => {
  ai = await FakeAi.start();
  dir = mkdtempSync(join(tmpdir(), 'allaya-e2e-conversation-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await ai.stop();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A "microphone" that says something every few seconds: a second of loud tone, then silence, repeating. To the
 * speech detector that is an utterance followed by a pause, which is all it needs to see.
 */
function speakingMicrophone(): string {
  const rate = 16_000;
  const seconds = 5;
  const samples = new Int16Array(rate * seconds);
  for (let i = 0; i < rate * 1.2; i += 1) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 300 * i) / rate) * 0.6 * 32767);
  }
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const file = join(dir, 'speech.wav');
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();

async function connect(page: Page) {
  for (const [provider, key] of [
    ['Anthropic', FakeAi.VALID_KEY],
    ['OpenAI', FakeAi.OPENAI_KEY],
  ] as const) {
    await nav(page, 'Models');
    const card = page
      .locator('div', { has: page.getByRole('heading', { name: provider, exact: true }) })
      .filter({ has: page.getByRole('button', { name: /Add API key/ }) })
      .last();
    await card.getByRole('button', { name: /Add API key/ }).click();
    await page.getByLabel('API key').fill(key);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`${provider} connected`)).toBeVisible();
  }
}

const transcriptions = () => ai.requests.filter((r) => r.url === '/v1/audio/transcriptions');
const chats = () => ai.requests.filter((r) => r.url === '/v1/messages');

test('one click on the microphone starts a conversation that goes on until it is ended', async () => {
  ai.reply = () => ['ঠিক আছে।'];
  app = await launchApp({
    args: [`--use-file-for-fake-audio-capture=${speakingMicrophone()}`],
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url, openai: `${ai.url}/v1` }) },
  });
  const { page } = app;
  await connect(page);

  // Consent, then the conversation starts by itself.
  await nav(page, 'Home');
  await page.getByRole('button', { name: 'Start voice mode' }).click();
  await page.getByRole('button', { name: 'Turn on voice' }).click();
  const end = page.getByRole('button', { name: 'End conversation' }).first();
  await expect(end).toBeVisible();
  await expect(page.getByRole('region', { name: 'Voice' })).toContainText('hands-free');

  // Without touching anything again, it hears, answers, and listens for the next thing — more than once.
  await expect.poll(() => chats().length, { timeout: 90_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('log')).toContainText('ঠিক আছে।');
  expect(transcriptions().length).toBeGreaterThanOrEqual(2);
  // Each utterance reached the chat as a voice message, checked the way a single one is.
  expect((chats().at(-1)!.body as { system: string }).system).toMatch(/Bengali/);

  // The person ends it: the microphone closes and nothing more is sent, however long the "speaker" keeps talking.
  await end.click();
  await expect(page.getByRole('button', { name: 'End conversation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start voice mode' }).first()).toBeVisible();
  await page.waitForTimeout(1500); // anything already on its way
  const heard = transcriptions().length;
  const asked = chats().length;
  await page.waitForTimeout(12_000); // more than two of the microphone's utterances
  expect(transcriptions()).toHaveLength(heard);
  expect(chats()).toHaveLength(asked);
});

test('the STOP button ends a conversation too', async () => {
  app = await launchApp({
    args: [`--use-file-for-fake-audio-capture=${speakingMicrophone()}`],
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url, openai: `${ai.url}/v1` }) },
  });
  const { page } = app;
  await connect(page);
  await nav(page, 'Home');
  await page.getByRole('button', { name: 'Start voice mode' }).click();
  await page.getByRole('button', { name: 'Turn on voice' }).click();
  await expect(page.getByRole('button', { name: 'End conversation' }).first()).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: /STOP/ }).click();
  await expect(page.getByRole('button', { name: 'End conversation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start voice mode' }).first()).toBeVisible();
});

test('with the setting off, the microphone is a single question, as before', async () => {
  app = await launchApp({
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url, openai: `${ai.url}/v1` }) },
  });
  const { page } = app;
  await connect(page);
  await page.evaluate(() =>
    window.allaya.invoke('settings:set', { key: 'voice.conversation', value: false }),
  );
  await nav(page, 'Home');
  await page.getByRole('button', { name: 'Start voice mode' }).click();
  await page.getByRole('button', { name: 'Turn on voice' }).click();
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'End conversation' })).toHaveCount(0);
});
