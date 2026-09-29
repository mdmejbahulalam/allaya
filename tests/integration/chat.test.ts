import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageView } from '@allaya/validation';
import { API_KEY, SONNET, hangingStream, modelsResponse, replyStream } from '../helpers/anthropic';
import { json, mockFetch, type RecordedRequest } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';
import { titleFromText } from '@main/services/chat-service';

let backend: TestBackend;
afterEach(() => backend?.dispose());

type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;

/** Backend with Anthropic connected; chat requests are answered by `onChat`. */
async function connected(
  onChat: (req: RecordedRequest, n: number) => Response | Promise<Response>,
) {
  let chatCalls = 0;
  const f = mockFetch((req) => {
    if (req.url.endsWith('/v1/models') || req.url.includes('/v1/models?')) return modelsResponse();
    return onChat(req, chatCalls++);
  });
  backend = createTestBackend({ fetch: f });
  await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
  return f;
}

const send = (text: string, extra: object = {}) => backend.call('chat:send', { text, ...extra });
const finished = (id?: string) =>
  backend
    .eventsOf('chat:finished')
    .filter((e) => !id || (e as { message: MessageView }).message.id === id) as Array<{
    message: MessageView;
  }>;
const waitForFinish = (id: string) =>
  vi.waitFor(() => expect(finished(id)).toHaveLength(1), { timeout: 3000 });

describe('chat without a provider (no-API-key mode)', () => {
  it('still accepts the message, and fails the assistant turn with an actionable, persisted error', async () => {
    backend = createTestBackend();
    const result = data<{
      conversation: { id: string; title: string };
      assistantMessage: MessageView;
    }>(await send('Downloads folder টা খুলে দাও'));
    await waitForFinish(result.assistantMessage.id);

    const final = finished()[0]!.message;
    expect(final.status).toBe('error');
    expect(final.error).toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(result.conversation.title).toBe('Downloads folder টা খুলে দাও');
    // It survives a reload.
    const messages = data<MessageView[]>(
      await backend.call('chat:getMessages', { conversationId: result.conversation.id }),
    );
    expect(messages.map((m) => [m.kind, m.status ?? null])).toEqual([
      ['user', null],
      ['assistant', 'error'],
    ]);
    expect(backend.container.runs.active()).toEqual([]);
  });
});

describe('chat with a connected provider', () => {
  it('streams deltas that concatenate to the persisted reply, with model and usage metadata', async () => {
    await connected(() =>
      replyStream(['হয়ে ', 'গেছে — ', 'Chrome খুলে দিয়েছি।'], { input: 30, output: 14 }),
    );
    const result = data<{
      conversation: { id: string };
      userMessage: MessageView;
      assistantMessage: MessageView;
    }>(await send('Chrome খুলে দাও'));

    expect(result.userMessage).toMatchObject({ kind: 'user', content: 'Chrome খুলে দাও' });
    expect(result.assistantMessage).toMatchObject({
      kind: 'assistant',
      status: 'streaming',
      content: '',
    });
    await waitForFinish(result.assistantMessage.id);

    const deltas = backend.eventsOf('chat:delta') as Array<{ text: string; messageId: string }>;
    expect(deltas.every((d) => d.messageId === result.assistantMessage.id)).toBe(true);
    const streamed = deltas.map((d) => d.text).join('');
    const final = finished()[0]!.message;
    expect(streamed).toBe('হয়ে গেছে — Chrome খুলে দিয়েছি।');
    expect(final).toMatchObject({
      status: 'complete',
      content: streamed,
      usage: { inputTokens: 30, outputTokens: 14 },
    });
    expect(final.model).toMatchObject({ providerId: 'anthropic' });
    expect(final.routeReason).toBeTruthy();

    // Persisted identically.
    const stored = data<MessageView[]>(
      await backend.call('chat:getMessages', { conversationId: result.conversation.id }),
    );
    expect(stored[1]).toMatchObject({ content: streamed, status: 'complete' });
    expect(backend.container.runs.active()).toEqual([]);
  });

  it('publishes agent status transitions: thinking → working → completed → ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await connected(() => replyStream(['ok']));
      const result = data<{ assistantMessage: MessageView }>(await send('hi'));
      await vi.waitFor(() => expect(finished(result.assistantMessage.id)).toHaveLength(1), {
        timeout: 3000,
      });
      await vi.advanceTimersByTimeAsync(3000);
      const statuses = (backend.eventsOf('agent:status') as Array<{ status: string }>).map(
        (s) => s.status,
      );
      expect(statuses).toEqual(['thinking', 'working', 'completed', 'ready']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends prior turns as context, the system prompt with language + honesty rules, and the user name', async () => {
    const requests: RecordedRequest[] = [];
    await connected((req) => {
      requests.push(req);
      return replyStream(['reply']);
    });
    await backend.call('settings:set', { key: 'profile.displayName', value: 'Babul' });
    const first = data<{ conversation: { id: string }; assistantMessage: MessageView }>(
      await send('আমার Downloads folder খুলে দাও'),
    );
    await waitForFinish(first.assistantMessage.id);
    const second = data<{ assistantMessage: MessageView }>(
      await send('এর মধ্যে PDF গুলো খুঁজে দাও', { conversationId: first.conversation.id }),
    );
    await waitForFinish(second.assistantMessage.id);

    const body = requests[1]!.body as {
      system: string;
      messages: Array<{ role: string; content: Array<{ text: string }> }>;
      stream: boolean;
    };
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[0]!.content[0]!.text).toBe('আমার Downloads folder খুলে দাও');
    expect(body.messages[2]!.content[0]!.text).toBe('এর মধ্যে PDF গুলো খুঁজে দাও');
    expect(body.system).toMatch(/Banglish/);
    expect(body.system).toMatch(/NO tools/); // never claims actions it cannot perform
    expect(body.system).toMatch(/Babul/);
    expect(body.stream).toBe(true);
  });

  it('honours the reply-language policy setting', async () => {
    const requests: RecordedRequest[] = [];
    await connected((req) => {
      requests.push(req);
      return replyStream(['ok']);
    });
    await backend.call('settings:set', { key: 'language.response', value: 'bn' });
    const r = data<{ assistantMessage: MessageView }>(await send('hello'));
    await waitForFinish(r.assistantMessage.id);
    expect((requests[0]!.body as { system: string }).system).toMatch(
      /Always reply in natural Bengali/,
    );
  });

  it('plain chat routes to the balanced tier, not the fastest model (quality, esp. Bengali)', async () => {
    const requests: RecordedRequest[] = [];
    await connected((req) => {
      requests.push(req);
      return replyStream(['ok']);
    });
    const r = data<{ assistantMessage: MessageView }>(await send('গতকালের PDF গুলো খুঁজে দাও'));
    await waitForFinish(r.assistantMessage.id);
    expect((requests[0]!.body as { model: string }).model).toBe(SONNET); // haiku is also connected
    expect(finished()[0]!.message.routeReason).toMatch(/balanced/);
  });

  it('a pinned model is used when eligible', async () => {
    const requests: RecordedRequest[] = [];
    await connected((req) => {
      requests.push(req);
      return replyStream(['ok']);
    });
    const r = data<{ assistantMessage: MessageView }>(
      await send('hi', {
        model: { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
      }),
    );
    await waitForFinish(r.assistantMessage.id);
    expect((requests[0]!.body as { model: string }).model).toBe('claude-haiku-4-5-20251001');
    expect(finished()[0]!.message.routeReason).toBe('Selected by you');
  });
});

describe('cancellation and the emergency stop', () => {
  it('cancelling mid-stream keeps the partial text, marks it cancelled, and frees the run', async () => {
    await connected((req) =>
      hangingStream('Partial answer', (req as unknown as { signal?: AbortSignal }).signal),
    );
    // The fetch double gets the AbortSignal via the recorded init; wire it through:
    backend.dispose();
    let signal: AbortSignal | undefined;
    const f = mockFetch(() => modelsResponse());
    const wrapped = (async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/messages')) {
        signal = init?.signal ?? undefined;
        return hangingStream('Partial answer', signal);
      }
      return f(url, init);
    }) as typeof f;
    backend = createTestBackend({ fetch: wrapped });
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });

    const r = data<{ conversation: { id: string }; assistantMessage: MessageView }>(
      await send('write me an essay'),
    );
    await vi.waitFor(
      () =>
        expect(
          (backend.eventsOf('chat:delta') as Array<{ text: string }>).map((d) => d.text).join(''),
        ).toContain('Partial answer'),
      { timeout: 3000 },
    );
    expect(backend.container.runs.active()).toHaveLength(1);

    expect(await backend.call('chat:cancel', { conversationId: r.conversation.id })).toMatchObject({
      ok: true,
      data: { cancelled: true },
    });
    await waitForFinish(r.assistantMessage.id);
    expect(finished()[0]!.message).toMatchObject({
      status: 'cancelled',
      content: 'Partial answer',
    });
    expect(backend.container.runs.active()).toEqual([]);
    // Cancelling again is a harmless no-op.
    expect(await backend.call('chat:cancel', { conversationId: r.conversation.id })).toMatchObject({
      data: { cancelled: false },
    });
  });

  it('agent:stop cancels every active run', async () => {
    const f = mockFetch(() => modelsResponse());
    const wrapped = (async (url: string, init?: RequestInit) =>
      url.includes('/v1/messages')
        ? hangingStream('working…', init?.signal ?? undefined)
        : f(url, init)) as typeof f;
    backend = createTestBackend({ fetch: wrapped });
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });

    const a = data<{ assistantMessage: MessageView }>(await send('task A'));
    const b = data<{ assistantMessage: MessageView }>(await send('task B'));
    await vi.waitFor(() => expect(backend.container.runs.active()).toHaveLength(2), {
      timeout: 3000,
    });
    expect(await backend.call('agent:getStatus')).toMatchObject({
      data: { status: 'working', activeRuns: 2 },
    });

    expect(await backend.call('agent:stop')).toMatchObject({ ok: true, data: { cancelled: 2 } });
    await waitForFinish(a.assistantMessage.id);
    await waitForFinish(b.assistantMessage.id);
    expect(finished().map((e) => e.message.status)).toEqual(['cancelled', 'cancelled']);
    expect(backend.container.runs.active()).toEqual([]);
    expect(await backend.call('agent:getStatus')).toMatchObject({
      data: { status: 'ready', activeRuns: 0 },
    });
  });

  it('sending while a reply is still streaming in the same conversation is rejected', async () => {
    const f = mockFetch(() => modelsResponse());
    const wrapped = (async (url: string, init?: RequestInit) =>
      url.includes('/v1/messages')
        ? hangingStream('…', init?.signal ?? undefined)
        : f(url, init)) as typeof f;
    backend = createTestBackend({ fetch: wrapped });
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
    const r = data<{ conversation: { id: string } }>(await send('first'));
    expect(await send('second', { conversationId: r.conversation.id })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    backend.container.runs.cancelAll();
  });
});

describe('failure handling', () => {
  it('a provider error becomes a persisted error state; the failed turn is excluded from the next request', async () => {
    const requests: RecordedRequest[] = [];
    await connected((req, n) => {
      requests.push(req);
      return n === 0
        ? json({ error: { message: 'boom' } }, { status: 500 })
        : replyStream(['fine']);
    });
    const first = data<{ conversation: { id: string }; assistantMessage: MessageView }>(
      await send('one'),
    );
    await waitForFinish(first.assistantMessage.id);
    expect(finished()[0]!.message).toMatchObject({
      status: 'error',
      error: { code: 'PROVIDER_UNAVAILABLE' },
    });

    const second = data<{ assistantMessage: MessageView }>(
      await send('two', { conversationId: first.conversation.id }),
    );
    await waitForFinish(second.assistantMessage.id);
    const roles = (requests[1]!.body as { messages: Array<{ role: string }> }).messages.map(
      (m) => m.role,
    );
    // The two user turns merge (API requires alternation) and no empty assistant turn was sent.
    expect(roles).toEqual(['user']);
  });

  it('a rejected key mid-session surfaces as PROVIDER_AUTH_FAILED on the message', async () => {
    await connected(() =>
      json({ error: { type: 'authentication_error', message: 'invalid' } }, { status: 401 }),
    );
    const r = data<{ assistantMessage: MessageView }>(await send('hi'));
    await waitForFinish(r.assistantMessage.id);
    expect(finished()[0]!.message.error).toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    expect(JSON.stringify(backend.events.events)).not.toContain('SECRETSECRET');
    expect(JSON.stringify(backend.logs.records)).not.toContain('SECRETSECRET');
  });

  it('interrupted messages are recovered as errors on the next startup', async () => {
    const dir = (await import('node:fs')).mkdtempSync(
      (await import('node:os')).tmpdir() + '/allaya-recover-',
    );
    const path = `${dir}/db.sqlite`;
    const first = createTestBackend({ databasePath: path });
    const { conversations } = { conversations: first.container.database.raw };
    conversations.prepare("INSERT INTO conversations (id, title) VALUES ('c1','t')").run();
    conversations
      .prepare(
        "INSERT INTO messages (id, conversation_id, kind, content, metadata_json) VALUES ('m1','c1','assistant','partial','{\"status\":\"streaming\"}')",
      )
      .run();
    first.dispose();

    backend = createTestBackend({ databasePath: path });
    const messages = data<MessageView[]>(
      await backend.call('chat:getMessages', { conversationId: 'c1' }),
    );
    expect(messages[0]).toMatchObject({
      status: 'error',
      content: 'partial',
      error: { code: 'CANCELLED', retryable: true },
    });
  });
});

describe('conversation management', () => {
  it('lists, renames, and soft-deletes conversations', async () => {
    await connected(() => replyStream(['ok']));
    const a = data<{ conversation: { id: string }; assistantMessage: MessageView }>(
      await send('first chat'),
    );
    await waitForFinish(a.assistantMessage.id);
    const list = data<Array<{ id: string; title: string }>>(
      await backend.call('chat:listConversations'),
    );
    expect(list.map((c) => c.title)).toEqual(['first chat']);

    expect(
      await backend.call('chat:renameConversation', {
        conversationId: a.conversation.id,
        title: '  Renamed  ',
      }),
    ).toMatchObject({ ok: true, data: { title: 'Renamed' } });
    expect(
      await backend.call('chat:deleteConversation', { conversationId: a.conversation.id }),
    ).toMatchObject({ data: { deleted: true } });
    expect(data<unknown[]>(await backend.call('chat:listConversations'))).toEqual([]);
    expect(
      await backend.call('chat:getMessages', { conversationId: a.conversation.id }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(
      await backend.call('chat:deleteConversation', { conversationId: a.conversation.id }),
    ).toMatchObject({ data: { deleted: false } });
  });

  it('validates input at the boundary', async () => {
    backend = createTestBackend();
    for (const text of ['', '   ', 'x'.repeat(20_001), 5, null]) {
      expect(await send(text as never), String(text).slice(0, 10)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_IPC_PAYLOAD' },
      });
    }
    expect(await backend.call('chat:getMessages', { conversationId: '' })).toMatchObject({
      ok: false,
    });
    expect(await send('hi', { conversationId: 'does-not-exist' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('titles are cut on code points, so Bengali conjuncts and emoji are never split', () => {
    const long = 'আমার Downloads folder খুলে দাও এবং গত সাত দিনের সব PDF ফাইল খুঁজে দাও 🙂🙂🙂🙂';
    const title = titleFromText(long);
    expect(Array.from(title).length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
    expect(() => new TextEncoder().encode(title)).not.toThrow();
    expect(title).not.toMatch(/�/);
    expect(titleFromText('  short   one \n line ')).toBe('short one line');
  });
});

void SONNET;
