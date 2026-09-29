import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepository } from '@allaya/database';
import type { ConversationView, MessageView } from '@allaya/validation';
import { API_KEY, hangingStream, modelsResponse, replyStream } from '../helpers/anthropic';
import { mockFetch, type RecordedRequest } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';

let backend: TestBackend;
afterEach(() => backend?.dispose());

type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;
interface SendResult {
  conversation: ConversationView;
  userMessage: MessageView;
  assistantMessage: MessageView;
}

/** A backend with Anthropic connected that records every chat request. */
async function connected(options: { hang?: boolean } = {}) {
  const requests: RecordedRequest[] = [];
  const base = mockFetch((req) => {
    requests.push(req);
    return replyStream(['ok']);
  });
  const f = (async (url: string, init?: RequestInit) => {
    if (url.includes('/v1/models')) return modelsResponse();
    if (options.hang && url.includes('/v1/messages'))
      return hangingStream('working…', init?.signal ?? undefined);
    return base(url, init);
  }) as typeof base;
  backend = createTestBackend({ fetch: f });
  await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
  return { requests: () => requests.filter((r) => r.url.includes('/v1/messages')) };
}

const send = async (text: string, conversationId?: string) =>
  data<SendResult>(
    await backend.call('chat:send', { text, ...(conversationId ? { conversationId } : {}) }),
  );
const finished = (id: string) =>
  (backend.eventsOf('chat:finished') as Array<{ message: MessageView }>).filter(
    (e) => e.message.id === id,
  );
const done = (id: string) =>
  vi.waitFor(() => expect(finished(id)).toHaveLength(1), { timeout: 3000 });
const systemOf = (req: RecordedRequest) => (req.body as { system: string }).system;

describe('the reply language follows the user', () => {
  it.each([
    ['Bengali script', 'Chrome খুলে দাও', /Bengali/],
    ['Banglish', 'amar Downloads folder ta open koro', /Bengali/],
    ['mixed Bengali/English', 'আমার notes.txt ফাইলটা open করো', /Bengali/],
    ['English', 'Please open my Downloads folder', /English/],
  ])('%s', async (_name, text, expected) => {
    const { requests } = await connected();
    const r = await send(text);
    await done(r.assistantMessage.id);
    expect(systemOf(requests()[0]!)).toMatch(expected);
    expect(systemOf(requests()[0]!)).toMatch(/latest message/);
  });

  it('persists the detected language on the user message', async () => {
    await connected();
    const r = await send('amar Downloads folder ta open koro');
    await done(r.assistantMessage.id);
    const row = new ConversationRepository(backend.container.database.db)
      .listMessages(r.conversation.id)
      .find((m) => m.id === r.userMessage.id)!;
    expect(row.language).toBe('romanized-bn');
    expect(JSON.parse(row.metadataJson!)).toMatchObject({ detected: { primary: 'bn' } });
  });

  it('a very short reply ("ok", "haan") keeps the language the conversation was in', async () => {
    const { requests } = await connected();
    const first = await send('আমার ফাইলগুলো দেখাও');
    await done(first.assistantMessage.id);
    const second = await send('ok', first.conversation.id);
    await done(second.assistantMessage.id);
    expect(systemOf(requests()[1]!)).toMatch(/too short to tell.*Bengali/);
  });

  it('the app-wide reply policy still applies when nothing else was requested', async () => {
    const { requests } = await connected();
    await backend.call('settings:set', { key: 'language.response', value: 'en' });
    const r = await send('Chrome খুলে দাও');
    await done(r.assistantMessage.id);
    expect(systemOf(requests()[0]!)).toMatch(/Always reply in clear English/);
  });
});

describe('"বাংলায় কথা বলো" / "Speak English" (handled without the model)', () => {
  it('switches the conversation language, answers in the new language, and makes no model call', async () => {
    const { requests } = await connected();
    const r = await send('বাংলায় কথা বলো');

    expect(r.assistantMessage).toMatchObject({
      kind: 'assistant',
      status: 'complete',
      content: 'ঠিক আছে, এখন থেকে বাংলায় কথা বলব।',
    });
    expect(r.conversation.language).toBe('bn');
    expect(requests()).toHaveLength(0);
    expect(backend.container.runs.active()).toEqual([]);
  });

  it('works with no API key configured (no provider is needed to change language)', async () => {
    backend = createTestBackend();
    const r = await send('Speak English');
    expect(r.assistantMessage.content).toMatch(/English from now on/);
    expect(r.assistantMessage.status).toBe('complete');
    expect(r.conversation.language).toBe('en');
  });

  it('later replies are requested in the chosen language regardless of what the user writes', async () => {
    const { requests } = await connected();
    const sw = await send('Speak English');
    const next = await send('আমার ফাইল খুঁজে দাও', sw.conversation.id);
    await done(next.assistantMessage.id);
    expect(systemOf(requests()[0]!)).toMatch(/asked you to speak this language.*English/);
    // ...and switching back is just as immediate.
    const back = await send('বাংলায় কথা বলো', sw.conversation.id);
    expect(back.conversation.language).toBe('bn');
    const again = await send('open notes.txt', sw.conversation.id);
    await done(again.assistantMessage.id);
    expect(systemOf(requests()[1]!)).toMatch(/asked you to speak this language.*Bengali/);
  });

  it('the choice is per conversation and beats the app-wide policy', async () => {
    const { requests } = await connected();
    await backend.call('settings:set', { key: 'language.response', value: 'bn' });
    const a = await send('Speak English');
    const other = await send('hello');
    await done(other.assistantMessage.id);
    expect(other.conversation.language).toBeNull();
    expect(systemOf(requests()[0]!)).toMatch(/Always reply in natural Bengali/);
    const inA = await send('hello again', a.conversation.id);
    await done(inA.assistantMessage.id);
    expect(systemOf(requests()[1]!)).toMatch(/asked you to speak this language.*English/);
  });

  it('can be set from the UI selector and cleared back to automatic', async () => {
    await connected();
    const r = await send('hello');
    await done(r.assistantMessage.id);
    const view = data<ConversationView>(
      await backend.call('chat:setLanguage', { conversationId: r.conversation.id, language: 'bn' }),
    );
    expect(view.language).toBe('bn');
    const cleared = data<ConversationView>(
      await backend.call('chat:setLanguage', {
        conversationId: r.conversation.id,
        language: 'auto',
      }),
    );
    expect(cleared.language).toBeNull();
    expect(
      await backend.call('chat:setLanguage', { conversationId: 'nope-nope', language: 'bn' }),
    ).toMatchObject({ ok: false });
    expect(
      await backend.call('chat:setLanguage', {
        conversationId: r.conversation.id,
        language: 'klingon',
      }),
    ).toMatchObject({ ok: false });
  });

  it('does not treat a sentence that merely mentions a language as a switch', async () => {
    const { requests } = await connected();
    for (const text of [
      'How do I speak Bengali fluently?',
      'বাংলায় কথা বলা শেখার সহজ উপায় কী?',
      'Google এ "speak english" search করো',
    ]) {
      const r = await send(text);
      await done(r.assistantMessage.id);
      expect(r.conversation.language, text).toBeNull();
    }
    expect(requests()).toHaveLength(3); // every one of them went to the model
  });
});

describe('typed "stop" / "থামাও"', () => {
  it('stops a running reply even though the conversation is busy', async () => {
    await connected({ hang: true });
    const first = await send('write me an essay');
    await vi.waitFor(() => expect(backend.container.runs.active()).toHaveLength(1), {
      timeout: 3000,
    });

    const stop = await send('থামাও', first.conversation.id);
    expect(stop.assistantMessage).toMatchObject({
      status: 'complete',
      content: 'থামিয়ে দিয়েছি।',
    });
    await done(first.assistantMessage.id);
    expect(finished(first.assistantMessage.id)[0]!.message.status).toBe('cancelled');
    expect(backend.container.runs.active()).toEqual([]);
  });

  it('answers in English when the user wrote English', async () => {
    await connected({ hang: true });
    const first = await send('write me an essay');
    await vi.waitFor(() => expect(backend.container.runs.active()).toHaveLength(1), {
      timeout: 3000,
    });
    const stop = await send('stop', first.conversation.id);
    expect(stop.assistantMessage.content).toBe('Stopped.');
    await done(first.assistantMessage.id);
  });

  it('stopping everything also stops runs in other conversations', async () => {
    await connected({ hang: true });
    const a = await send('task A');
    const b = await send('task B');
    await vi.waitFor(() => expect(backend.container.runs.active()).toHaveLength(2), {
      timeout: 3000,
    });
    const stop = await send('stop', b.conversation.id);
    expect(stop.assistantMessage.content).toBe('Stopped 2 tasks.');
    await done(a.assistantMessage.id);
    await done(b.assistantMessage.id);
  });

  it('says so plainly when there is nothing to stop', async () => {
    await connected();
    expect((await send('stop')).assistantMessage.content).toBe('Nothing is running right now.');
    expect((await send('থামো')).assistantMessage.content).toBe('এখন কিছু চলছে না।');
  });

  it('"cancel" only cancels the reply in this conversation', async () => {
    await connected({ hang: true });
    const a = await send('task A');
    const b = await send('task B');
    await vi.waitFor(() => expect(backend.container.runs.active()).toHaveLength(2), {
      timeout: 3000,
    });
    const cancel = await send('cancel', a.conversation.id);
    expect(cancel.assistantMessage.content).toBe('Okay, cancelled.');
    await done(a.assistantMessage.id);
    expect(backend.container.runs.active().map((r) => r.id)).toEqual([`chat:${b.conversation.id}`]);
    backend.container.runs.cancelAll();
    await done(b.assistantMessage.id);
  });

  it('a stop word inside a real request never triggers a stop', async () => {
    const { requests } = await connected();
    for (const text of [
      'how do I stop Chrome from starting up',
      'stop the download of setup.exe',
      'Chrome কীভাবে থামাবো?',
      'please stop and explain why the file is empty',
    ]) {
      const r = await send(text);
      await done(r.assistantMessage.id);
      expect(r.assistantMessage.status, text).toBe('streaming'); // went to the model
    }
    expect(requests()).toHaveLength(4);
  });

  it('control commands are stored in the transcript like any other message', async () => {
    await connected();
    const r = await send('বাংলায় কথা বলো');
    const stored = data<MessageView[]>(
      await backend.call('chat:getMessages', { conversationId: r.conversation.id }),
    );
    expect(stored.map((m) => [m.kind, m.status ?? null])).toEqual([
      ['user', null],
      ['assistant', 'complete'],
    ]);
    expect(stored[1]!.content).toBe('ঠিক আছে, এখন থেকে বাংলায় কথা বলব।');
  });
});

/** Documents the guard that keeps long text away from the control-command path. */
describe('control commands are short', () => {
  it('a very long message is never handled locally', async () => {
    const { requests } = await connected();
    const r = await send(`stop ${'x'.repeat(200)}`);
    await done(r.assistantMessage.id);
    expect(requests()).toHaveLength(1);
  });
});
