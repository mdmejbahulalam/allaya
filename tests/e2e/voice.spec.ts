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
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url, openai: `${ai.url}/v1` }) },
  }));

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
    .click();

async function addKey(page: Page, provider: 'Anthropic' | 'OpenAI', key: string) {
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

/** Can the renderer open the microphone right now? (Asks the real Chromium + main-process permission handler.) */
const micAccess = (page: Page) =>
  page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return 'granted';
    } catch (error) {
      return (error as DOMException).name;
    }
  });

const cameraAccess = (page: Page) =>
  page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const track of stream.getTracks()) track.stop();
      return 'granted';
    } catch (error) {
      return (error as DOMException).name;
    }
  });

async function connectEverything(page: Page) {
  await addKey(page, 'Anthropic', FakeAi.VALID_KEY);
  await addKey(page, 'OpenAI', FakeAi.OPENAI_KEY);
}

/** Turns voice on through the real consent dialog. */
async function enableVoice(page: Page) {
  await nav(page, 'Home');
  await page.getByRole('button', { name: 'Start voice mode' }).click();
  await expect(page.getByRole('dialog', { name: 'Turn on voice?' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn on voice' }).click();
}

const chatRequests = () => ai.requests.filter((r) => r.url === '/v1/messages');
const speechRequests = () => ai.requests.filter((r) => r.url === '/v1/audio/transcriptions');

test('the microphone is denied until the user has consented — and the camera is never available', async () => {
  const { page } = await start();
  expect(await micAccess(page)).toBe('NotAllowedError');
  expect(await cameraAccess(page)).toBe('NotAllowedError');

  await page.getByRole('button', { name: 'Start voice mode' }).click();
  const dialog = page.getByRole('dialog', { name: 'Turn on voice?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Allaya does not save recordings');
  await expect(dialog).toContainText('needs an OpenAI API key'); // nothing to transcribe with yet
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await micAccess(page)).toBe('NotAllowedError'); // cancelling changed nothing

  await page.getByRole('button', { name: 'Start voice mode' }).click();
  await page.getByRole('button', { name: 'Turn on voice' }).click();
  await expect.poll(() => micAccess(page)).toBe('granted');
  expect(await cameraAccess(page)).toBe('NotAllowedError'); // consent is for the microphone only
});

test('turning voice off in Settings takes the microphone away again', async () => {
  const { page } = await start();
  await enableVoice(page);
  await expect.poll(() => micAccess(page)).toBe('granted');

  await nav(page, 'Settings');
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('switch', { name: 'Voice input' }).click();
  await expect(page.getByRole('switch', { name: 'Voice input' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect.poll(() => micAccess(page)).toBe('NotAllowedError');
});

test('speaking a command: microphone → speech-to-text → the message is sent and answered', async () => {
  ai.reply = () => ['ঠিক আছে।'];
  const { page } = await start();
  await connectEverything(page);
  await enableVoice(page);

  // Voice starts straight after consent.
  await expect(page.getByRole('region', { name: 'Voice' })).toContainText('Listening');
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
  // The always-visible emergency STOP is available while the microphone is open.
  await expect(page.getByRole('banner').getByRole('button', { name: /STOP/ })).toBeVisible();

  await page.waitForTimeout(1200); // let the fake device produce some audio
  await page.getByRole('button', { name: 'Stop listening' }).click();

  await expect(page.getByRole('log')).toContainText('Chrome খুলে দাও', { timeout: 15_000 });
  await expect(page.getByRole('log')).toContainText('ঠিক আছে।', { timeout: 15_000 });

  const upload = speechRequests()[0]!;
  expect(upload.headers['authorization']).toBe(`Bearer ${FakeAi.OPENAI_KEY}`);
  expect(upload.uploadBytes).toBeGreaterThan(500); // real audio left the microphone
  expect(upload.fields).toMatchObject({ model: 'whisper-1', response_format: 'verbose_json' });
  expect((chatRequests().at(-1)!.body as { system: string }).system).toMatch(/Bengali/);

  // Back to idle, and the recording is gone: nothing about it is in the DOM or storage.
  await expect(page.getByRole('button', { name: 'Start voice mode' })).toBeVisible();
  const leaked = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(leaked).not.toContain('audio/webm');
});

test('an uncertain transcript is held for review — nothing is sent until the user confirms', async () => {
  ai.transcript = { text: 'Chrome খুলে দাও', avgLogprob: -0.55, noSpeechProb: 0.02 };
  ai.reply = () => ['ঠিক আছে।'];
  const { page } = await start();
  await connectEverything(page);
  await enableVoice(page);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Stop listening' }).click();

  const region = page.getByRole('region', { name: 'Voice' });
  await expect(region).toContainText('Did I hear you right?', { timeout: 15_000 });
  await expect(region).toContainText("I'm not sure I heard that correctly");
  await expect(region).toContainText(/Confidence: \d+%/);
  expect(chatRequests()).toHaveLength(0);

  // The user fixes the text, then sends.
  const box = region.getByRole('textbox', { name: 'What I heard' });
  await expect(box).toHaveValue('Chrome খুলে দাও');
  await box.fill('Edge খুলে দাও');
  await region.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Edge খুলে দাও');
  await expect.poll(() => chatRequests().length).toBe(1);
  expect(
    (chatRequests()[0]!.body as { messages: Array<{ content: Array<{ text: string }> }> })
      .messages[0]!.content[0]!.text,
  ).toBe('Edge খুলে দাও');
});

test('a destructive command is ALWAYS reviewed, even when the user chose "send everything"', async () => {
  ai.transcript = { text: 'report.docx ডিলিট করে দাও', avgLogprob: -0.01, noSpeechProb: 0 };
  const { page } = await start();
  await connectEverything(page);
  await nav(page, 'Settings');
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sending voice messages' }).click();
  await page.getByRole('option', { name: 'Send everything except risky commands' }).click();

  await enableVoice(page);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Stop listening' }).click();

  const region = page.getByRole('region', { name: 'Voice' });
  await expect(region).toContainText('This sounds like a delete request', { timeout: 15_000 });
  expect(chatRequests()).toHaveLength(0);
  await region.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('region', { name: 'Voice' })).toHaveCount(0);
  expect(chatRequests()).toHaveLength(0); // dismissing sends nothing
});

test('silence is not turned into a message', async () => {
  ai.transcript = { text: 'Thanks for watching!', avgLogprob: -1.5, noSpeechProb: 0.9 };
  const { page } = await start();
  await connectEverything(page);
  await enableVoice(page);
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Stop listening' }).click();
  await expect(page.getByRole('region', { name: 'Voice' })).toContainText(
    "I didn't hear anything",
    { timeout: 15_000 },
  );
  expect(chatRequests()).toHaveLength(0);
});

test('the emergency STOP silences the microphone immediately and nothing is transcribed', async () => {
  const { page } = await start();
  await connectEverything(page);
  await enableVoice(page);
  await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();

  await page.getByRole('banner').getByRole('button', { name: /STOP/ }).click();
  await expect(page.getByRole('button', { name: 'Start voice mode' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Voice' })).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(speechRequests()).toHaveLength(0);
});

test('replies can be read aloud through the cloud voice, in the reply language', async () => {
  ai.reply = () => ['হয়ে গেছে।'];
  const { page } = await start();
  await connectEverything(page);
  await enableVoice(page);
  await page.getByRole('button', { name: 'Stop listening' }).click(); // cancel the automatic listening

  await nav(page, 'Settings');
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('switch', { name: 'Read replies aloud' }).click();
  await page.getByRole('combobox', { name: 'Voice', exact: true }).click();
  await page.getByRole('option', { name: 'Cloud voice (OpenAI)' }).click();

  await nav(page, 'Chat');
  const composer = page.getByRole('textbox', { name: 'Message Allaya…' });
  await composer.fill('Chrome খুলে দাও');
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText('হয়ে গেছে।', { timeout: 15_000 });

  await expect
    .poll(() => ai.requests.filter((r) => r.url === '/v1/audio/speech').length, { timeout: 15_000 })
    .toBe(1);
  const spoken = ai.requests.find((r) => r.url === '/v1/audio/speech')!;
  expect(spoken.body).toMatchObject({
    input: 'হয়ে গেছে।',
    model: 'gpt-4o-mini-tts',
    response_format: 'mp3',
  });
});

test('with no Bengali voice installed, a system-voice reply stays text and explains why', async () => {
  ai.reply = () => ['হয়ে গেছে।'];
  const { page } = await start();
  await connectEverything(page);
  await enableVoice(page);
  await page.getByRole('button', { name: 'Stop listening' }).click();
  await nav(page, 'Settings');
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('switch', { name: 'Read replies aloud' }).click();

  await nav(page, 'Chat');
  const composer = page.getByRole('textbox', { name: 'Message Allaya…' });
  await composer.fill('Chrome খুলে দাও');
  await composer.press('Enter');
  await expect(page.getByRole('log')).toContainText('হয়ে গেছে।', { timeout: 15_000 });
  // This CI machine has no speech voices at all, which is exactly the situation being handled.
  await expect(page.getByRole('region', { name: 'Voice' })).toContainText(
    'No Bengali voice is installed',
    { timeout: 10_000 },
  );
  expect(ai.requests.filter((r) => r.url === '/v1/audio/speech')).toHaveLength(0);
});
