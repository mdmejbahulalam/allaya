import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageView, ProviderView } from '@allaya/validation';
import { json, mockFetch, sse, streamResponse, type RecordedRequest } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';

let backend: TestBackend;
afterEach(() => backend?.dispose());

type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const GROQ_KEY = 'gsk_SECRETSECRETSECRETSECRET';
const rows = (table: string) =>
  backend.container.database.raw.prepare(`SELECT * FROM ${table}`).all() as Array<
    Record<string, unknown>
  >;
const view = async (id: string) =>
  data<ProviderView[]>(await backend.call('providers:list')).find((p) => p.id === id)!;

const groqModels = () =>
  json({
    data: [
      { id: 'llama-3.3-70b-versatile', created: 2 },
      { id: 'whisper-large-v3', created: 3 },
      { id: 'llama-3.1-8b-instant', created: 1 },
    ],
  });

describe('a cloud provider that speaks the OpenAI format', () => {
  it('connects with a key, lists its chat models, and never exposes the key', async () => {
    const f = mockFetch(() => groqModels());
    backend = createTestBackend({ fetch: f });
    const result = await backend.call('providers:setKey', { providerId: 'groq', apiKey: GROQ_KEY });
    expect(result).toMatchObject({
      ok: true,
      data: { id: 'groq', name: 'Groq', setup: 'key', status: 'connected' },
    });
    const models = (result as Ok<ProviderView>).data.models.map((m) => m.modelId);
    expect(models).toEqual(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
    expect(f.requests[0]!.url).toBe('https://api.groq.com/openai/v1/models');
    expect(f.requests[0]!.headers['authorization']).toBe(`Bearer ${GROQ_KEY}`);
    for (const surface of [
      JSON.stringify(result),
      JSON.stringify(rows('api_credentials')),
      JSON.stringify(backend.logs.records),
      JSON.stringify(backend.events.events),
    ])
      expect(surface).not.toContain('SECRETSECRET');
    expect(await backend.call('models:list')).toMatchObject({
      data: [{ providerId: 'groq' }, { providerId: 'groq' }],
    });
  });

  it('a person can choose one of its models, and chat then goes to it', async () => {
    const requests: RecordedRequest[] = [];
    backend = createTestBackend({
      fetch: mockFetch((req) => {
        requests.push(req);
        if (req.url.endsWith('/models')) return groqModels();
        return streamResponse([
          sse({ model: 'llama-3.1-8b-instant', choices: [{ delta: { content: 'হ্যালো!' } }] }),
          sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          sse('[DONE]'),
        ]);
      }),
    });
    await backend.call('providers:setKey', { providerId: 'groq', apiKey: GROQ_KEY });
    expect(
      await backend.call('models:setRouting', {
        autoRouting: false,
        assignments: { general: { providerId: 'groq', modelId: 'llama-3.1-8b-instant' } },
      }),
    ).toMatchObject({ ok: true });
    const sent = data<{ assistantMessage: MessageView }>(
      await backend.call('chat:send', { text: 'hello' }),
    );
    await vi.waitFor(() => expect(backend.eventsOf('chat:finished').length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const chat = requests.find((r) => r.url.endsWith('/chat/completions'))!;
    expect(chat.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(chat.body).toMatchObject({ model: 'llama-3.1-8b-instant', stream: true });
    const final = (backend.eventsOf('chat:finished') as Array<{ message: MessageView }>)[0]!
      .message;
    expect(final.id).toBe(sent.assistantMessage.id);
    expect(final.content).toBe('হ্যালো!');
  });

  it('a model that is not on its list cannot be chosen', async () => {
    backend = createTestBackend({ fetch: mockFetch(() => groqModels()) });
    await backend.call('providers:setKey', { providerId: 'groq', apiKey: GROQ_KEY });
    expect(
      await backend.call('models:setRouting', {
        assignments: { general: { providerId: 'groq', modelId: 'whisper-large-v3' } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('a key the service rejects is not kept, and the error does not echo it', async () => {
    backend = createTestBackend({
      fetch: mockFetch(() => json({ error: { message: `bad ${GROQ_KEY}` } }, { status: 401 })),
    });
    const result = await backend.call('providers:setKey', { providerId: 'groq', apiKey: GROQ_KEY });
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_AUTH_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('SECRETSECRET');
    expect(rows('api_credentials')).toHaveLength(0);
    expect((await view('groq')).status).toBe('not_configured');
  });

  it('refreshing lists the models again, and removing forgets the key and the models', async () => {
    let list = groqModels();
    backend = createTestBackend({ fetch: mockFetch(() => list.clone()) });
    await backend.call('providers:setKey', { providerId: 'groq', apiKey: GROQ_KEY });
    list = json({ data: [{ id: 'llama-4-scout', created: 9 }] });
    const refreshed = data<ProviderView>(
      await backend.call('providers:refreshModels', { providerId: 'groq' }),
    );
    expect(refreshed.models.map((m) => m.modelId)).toEqual(['llama-4-scout']);
    await backend.call('providers:removeKey', { providerId: 'groq' });
    expect(await view('groq')).toMatchObject({ status: 'not_configured', models: [] });
    expect(rows('api_credentials')).toHaveLength(0);
  });
});

describe('a server on this computer, or a service at an address the person chose', () => {
  const OLLAMA = 'http://localhost:11434/v1';
  const local = () => json({ data: [{ id: 'qwen2.5:7b' }, { id: 'llama3.2:3b' }] });

  it('is listed as set up with an address, not a key', async () => {
    backend = createTestBackend();
    expect(await view('ollama')).toMatchObject({ setup: 'endpoint', status: 'not_configured' });
    expect(await view('custom')).toMatchObject({ setup: 'endpoint' });
    expect(await view('groq')).toMatchObject({ setup: 'key' });
  });

  it('connects to a local server with no key, and lists what it offers', async () => {
    const f = mockFetch(() => local());
    backend = createTestBackend({ fetch: f });
    const result = await backend.call('providers:setEndpoint', {
      providerId: 'ollama',
      baseUrl: `${OLLAMA}/`,
    });
    expect(result).toMatchObject({
      ok: true,
      data: { id: 'ollama', status: 'connected', keyless: true, baseUrl: OLLAMA },
    });
    expect((result as Ok<ProviderView>).data.maskedKey).toBeUndefined();
    expect((result as Ok<ProviderView>).data.models.map((m) => m.modelId)).toEqual([
      'qwen2.5:7b',
      'llama3.2:3b',
    ]);
    expect(f.requests[0]!.url).toBe(`${OLLAMA}/models`);
  });

  it('a key, if the person gives one, is used and hidden like any other', async () => {
    const f = mockFetch(() => local());
    backend = createTestBackend({ fetch: f });
    const result = await backend.call('providers:setEndpoint', {
      providerId: 'custom',
      baseUrl: 'https://models.example.com/v1',
      apiKey: 'my-private-token-0123456789',
    });
    expect(result).toMatchObject({ ok: true, data: { status: 'connected', setup: 'endpoint' } });
    expect(f.requests[0]!.headers['authorization']).toBe('Bearer my-private-token-0123456789');
    expect(JSON.stringify(result)).not.toContain('0123456789');
    expect(JSON.stringify(rows('api_credentials'))).not.toContain('0123456789');
    expect(JSON.stringify(backend.logs.records)).not.toContain('0123456789');
  });

  it('chat goes to the chosen address, and a changed address applies at once', async () => {
    const urls: string[] = [];
    backend = createTestBackend({
      fetch: mockFetch((req) => {
        urls.push(req.url);
        if (req.url.endsWith('/models')) return local();
        return streamResponse([
          sse({ choices: [{ delta: { content: 'ok' } }] }),
          sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          sse('[DONE]'),
        ]);
      }),
    });
    await backend.call('providers:setEndpoint', { providerId: 'ollama', baseUrl: OLLAMA });
    await backend.call('models:setRouting', {
      autoRouting: false,
      assignments: { general: { providerId: 'ollama', modelId: 'qwen2.5:7b' } },
    });
    await backend.call('chat:send', { text: 'hi' });
    await vi.waitFor(() => expect(backend.eventsOf('chat:finished')).toHaveLength(1), {
      timeout: 3000,
    });
    expect(urls.at(-1)).toBe(`${OLLAMA}/chat/completions`);

    await backend.call('providers:setEndpoint', {
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    await backend.call('providers:refreshModels', { providerId: 'ollama' });
    expect(urls.at(-1)).toBe('http://127.0.0.1:9999/v1/models');
  });

  it.each([
    ['http://example.com/v1', 'insecure_remote'],
    ['http://192.168.1.5:11434/v1', 'insecure_remote'],
    ['https://user:pass@example.com/v1', 'credentials'],
    ['https://example.com/v1?key=abc', 'query'],
    ['ftp://example.com', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['nonsense', 'malformed'],
  ])('refuses %s without contacting it', async (baseUrl, reason) => {
    const f = mockFetch(() => local());
    backend = createTestBackend({ fetch: f });
    const result = await backend.call('providers:setEndpoint', { providerId: 'custom', baseUrl });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', details: { reason } },
    });
    expect(f.requests).toHaveLength(0);
    expect(rows('api_credentials')).toHaveLength(0);
    expect((await view('custom')).baseUrl).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('pass@');
  });

  it('a server that is switched off is kept, in an error state, so it can be tried again', async () => {
    backend = createTestBackend({
      fetch: mockFetch(() => {
        throw new TypeError('fetch failed');
      }),
    });
    const result = await backend.call('providers:setEndpoint', {
      providerId: 'ollama',
      baseUrl: OLLAMA,
    });
    expect(result).toMatchObject({ ok: true, data: { status: 'error', baseUrl: OLLAMA } });
    expect(data<ProviderView>(result).models).toEqual([]);
  });

  it('a service that rejects the key is not kept', async () => {
    backend = createTestBackend({
      fetch: mockFetch(() => json({ error: { message: 'nope' } }, { status: 401 })),
    });
    const result = await backend.call('providers:setEndpoint', {
      providerId: 'custom',
      baseUrl: 'https://models.example.com/v1',
      apiKey: 'wrong-token-0123456789',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_AUTH_FAILED' } });
    expect(rows('api_credentials')).toHaveLength(0);
    expect(await view('custom')).toMatchObject({ status: 'not_configured' });
    expect((await view('custom')).baseUrl).toBeUndefined();
  });

  it('disconnecting forgets the address, the key and the models', async () => {
    backend = createTestBackend({ fetch: mockFetch(() => local()) });
    await backend.call('providers:setEndpoint', { providerId: 'ollama', baseUrl: OLLAMA });
    await backend.call('providers:removeKey', { providerId: 'ollama' });
    expect(await view('ollama')).toMatchObject({ status: 'not_configured', models: [] });
    expect((await view('ollama')).baseUrl).toBeUndefined();
  });

  it('the two ways of setting up are not interchangeable', async () => {
    const f = mockFetch(() => local());
    backend = createTestBackend({ fetch: f });
    expect(
      await backend.call('providers:setKey', { providerId: 'ollama', apiKey: 'a-key-0123456789' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(
      await backend.call('providers:setEndpoint', { providerId: 'groq', baseUrl: OLLAMA }),
    ).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(0);
  });

  it('rejects oversized and malformed input', async () => {
    backend = createTestBackend({ fetch: mockFetch(() => local()) });
    expect(
      await backend.call('providers:setEndpoint', {
        providerId: 'ollama',
        baseUrl: `https://a.example/${'x'.repeat(400)}`,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await backend.call('providers:setEndpoint', { providerId: 'ollama', baseUrl: 42 }),
    ).toMatchObject({ ok: false });
    expect(
      await backend.call('providers:setEndpoint', { providerId: 'nope', baseUrl: OLLAMA }),
    ).toMatchObject({ ok: false });
  });
});
