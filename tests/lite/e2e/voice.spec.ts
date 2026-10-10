import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FakeAi } from '../../e2e/fake-ai';
import { launchLite, type LaunchedApp } from './fixtures';

let ai: FakeAi;
let app: LaunchedApp | undefined;
let dir: string;
test.beforeEach(async () => {
  ai = await FakeAi.start();
  dir = mkdtempSync(join(tmpdir(), 'allaya-lite-voice-'));
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
  const samples = new Int16Array(rate * 5);
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

const start = async (withMicrophone = false) =>
  (app = await launchLite({
    ...(withMicrophone
      ? { args: [`--use-file-for-fake-audio-capture=${speakingMicrophone()}`] }
      : {}),
    env: {
      ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url, openai: `${ai.url}/v1` }),
    },
  }));

const settings = (page: Page) => page.getByRole('button', { name: 'Settings' }).click();
const transcriptions = () => ai.requests.filter((r) => r.url === '/v1/audio/transcriptions');
const speeches = () => ai.requests.filter((r) => r.url === '/v1/audio/speech');
const chats = () => ai.requests.filter((r) => r.url === '/v1/messages');

async function connect(page: Page, preset: string, key: string) {
  await settings(page);
  await page.getByRole('tab', { name: 'AI services' }).click();
  await page.getByRole('button', { name: 'Add a service' }).click();
  await page.getByRole('button', { name: preset }).click();
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`“${preset}” connected.`)).toBeVisible();
}

test('one click on the microphone starts a spoken conversation that goes on until it is ended', async () => {
  ai.reply = (text) => [`You said: ${text}`];
  ai.transcript = { text: 'What is the weather?', avgLogprob: -0.08, noSpeechProb: 0.01 };
  const { page } = await start(true);
  await connect(page, 'Anthropic (Claude)', FakeAi.VALID_KEY);
  await connect(page, 'OpenAI (GPT)', FakeAi.OPENAI_KEY);
  // Speak with OpenAI's voice (the default is this computer's own, which a test machine does not have).
  await page.getByRole('tab', { name: 'Voice' }).click();
  await page.getByLabel('Speaking (text to speech)').selectOption({ label: 'OpenAI (GPT)' });
  await expect(page.getByRole('combobox', { name: 'Voice', exact: true })).toHaveValue('alloy');
  await page.getByRole('button', { name: 'Back to chat' }).click();

  await page.getByRole('button', { name: 'Talk' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Listening' })).toBeVisible();
  // The first utterance is heard, understood, answered and read aloud.
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText('What is the weather?', { exact: true })).toBeVisible();
  await expect(log.getByText('You said: What is the weather?')).toBeVisible();
  await expect.poll(() => speeches().length).toBeGreaterThan(0);
  expect(speeches()[0]!.headers['authorization']).toBe(`Bearer ${FakeAi.OPENAI_KEY}`);
  expect((speeches()[0]!.body as { input: string }).input).toBe('You said: What is the weather?');

  // Then it listens again, and the conversation carries on without another click.
  await expect.poll(() => chats().length, { timeout: 30_000 }).toBeGreaterThan(1);
  expect(transcriptions().length).toBeGreaterThan(1);

  await page.getByRole('button', { name: 'End conversation' }).first().click();
  await expect(page.getByRole('button', { name: 'Talk' })).toBeVisible();
  const heard = transcriptions().length;
  await page.waitForTimeout(1500);
  expect(transcriptions().length).toBe(heard);
});

test('without a service that can listen, the microphone says what to do instead of failing', async () => {
  const { page } = await start();
  await connect(page, 'Anthropic (Claude)', FakeAi.VALID_KEY);
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await page.getByRole('button', { name: 'Talk' }).click();
  await expect(page.getByRole('status')).toContainText('connect OpenAI, Google or Groq');
  await page.getByRole('status').getByRole('button', { name: 'Connect a service' }).click();
  await expect(page.getByRole('heading', { name: 'AI services', level: 2 })).toBeVisible();
  expect(transcriptions()).toHaveLength(0);
});

test('the voice settings list what each connected service can do, and a voice can be tried', async () => {
  const { page } = await start();
  await connect(page, 'OpenAI (GPT)', FakeAi.OPENAI_KEY);
  await page.getByRole('tab', { name: 'Voice' }).click();
  await expect(page.getByText('Listening with OpenAI (GPT).')).toBeVisible();
  const speaking = page.getByLabel('Speaking (text to speech)');
  await expect(speaking.locator('option')).toHaveText([
    'This computer’s voice (free)',
    'OpenAI (GPT)',
  ]);
  await speaking.selectOption({ label: 'OpenAI (GPT)' });
  await page.getByRole('combobox', { name: 'Voice', exact: true }).selectOption('nova');
  await page.getByRole('button', { name: 'Try the voice' }).click();
  await expect.poll(() => speeches().length).toBe(1);
  expect(speeches()[0]!.body).toMatchObject({ voice: 'nova', model: 'gpt-4o-mini-tts' });
  // The choice is kept.
  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByRole('tab', { name: 'Voice' }).click();
  await expect(page.getByRole('combobox', { name: 'Voice', exact: true })).toHaveValue('nova');
});

test('a reply can be read aloud on request', async () => {
  ai.reply = () => ['Hello from Allaya.'];
  const { page } = await start();
  await connect(page, 'Anthropic (Claude)', FakeAi.VALID_KEY);
  await connect(page, 'OpenAI (GPT)', FakeAi.OPENAI_KEY);
  await page.getByRole('tab', { name: 'Voice' }).click();
  await page.getByLabel('Speaking (text to speech)').selectOption({ label: 'OpenAI (GPT)' });
  await page.getByRole('button', { name: 'Back to chat' }).click();
  const box = page.getByRole('textbox', { name: 'Message Allaya…' });
  await box.fill('Say hello');
  await box.press('Enter');
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText('Hello from Allaya.')).toBeVisible();
  expect(speeches()).toHaveLength(0);
  await log.getByRole('button', { name: 'Read aloud' }).click({ force: true });
  await expect.poll(() => speeches().length).toBe(1);
});
