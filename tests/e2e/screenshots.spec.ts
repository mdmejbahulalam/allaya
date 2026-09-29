import { test, type Page } from '@playwright/test';
import { FakeAi } from './fake-ai';
import { launchApp } from './fixtures';

/** Visual review helper: `ALLAYA_SCREENSHOTS=/some/dir pnpm test:e2e -g screenshots`. Skipped otherwise. */
const dir = process.env['ALLAYA_SCREENSHOTS'];
test.skip(!dir, 'set ALLAYA_SCREENSHOTS to capture review screenshots');

const nav = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: /Primary navigation|প্রধান নেভিগেশন/ })
    .getByRole('button', { name, exact: true })
    .click();

test('capture chat and models screens', async () => {
  const ai = await FakeAi.start();
  ai.chunkDelayMs = 0;
  ai.reply = () => [
    'অবশ্যই! এখানে একটি ছোট উদাহরণ:\n\n',
    '- **Downloads** folder খুলুন\n- `PDF` ফাইলগুলো ফিল্টার করুন\n- গত ৭ দিনের ফাইল বেছে নিন\n\n',
    '```powershell\nGet-ChildItem ~/Downloads -Filter *.pdf\n```\n',
    'আর কিছু লাগলে বলুন।',
  ];
  const app = await launchApp({
    env: { ALLAYA_E2E_AI_BASE_URLS: JSON.stringify({ anthropic: ai.url }) },
  });
  try {
    const { page } = app;
    await app.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1440, 900),
    );
    await nav(page, 'Models');
    await page.screenshot({ path: `${dir}/models-empty.png` });
    await page
      .getByRole('button', { name: /Add API key/ })
      .first()
      .click();
    await page.getByLabel('API key').fill(FakeAi.VALID_KEY);
    await page.screenshot({ path: `${dir}/models-key-modal.png` });
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Anthropic connected').waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/models-connected.png` });

    await nav(page, 'Chat');
    const composer = page.getByRole('textbox', { name: 'Message Allaya…' });
    await composer.fill('আমার Downloads folder থেকে গত ৭ দিনের PDF খুঁজে দাও');
    await composer.press('Enter');
    await page.getByRole('log').getByText('আর কিছু লাগলে বলুন।').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/chat-reply.png` });

    await page.evaluate(() =>
      window.allaya.invoke('settings:set', { key: 'language.ui', value: 'bn' }),
    );
    await page.evaluate(() =>
      window.allaya.invoke('settings:set', { key: 'appearance.theme', value: 'light' }),
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/chat-bn-light.png` });
  } finally {
    await app.close();
    await ai.stop();
  }
});
