import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '@allaya/types';
import { VENDORS, createProviderRegistry, modelEntries } from '@allaya/ai';
import { json, mockFetch, sse, streamResponse } from '../../helpers/fetch';

const KEY = 'gsk_SECRETSECRETSECRETSECRET';
const registry = (fetch: ReturnType<typeof mockFetch>, extra: object = {}) =>
  createProviderRegistry({
    getApiKey: async () => KEY,
    fetch,
    maxRetries: 0,
    backoffMs: 0,
    ...extra,
  });

describe('the provider registry', () => {
  it('has an adapter for every provider id', () => {
    const r = registry(mockFetch([json({})]));
    expect(r.list().map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    for (const v of VENDORS) expect(r.get(v.id).name).toBe(v.name);
  });

  it('vendor addresses are https, except the two the person points at a server', () => {
    for (const v of VENDORS) {
      if (v.id === 'ollama' || v.id === 'custom')
        expect(v.defaultBaseUrl).toMatch(/^http:\/\/localhost/);
      else expect(v.defaultBaseUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('discovering a vendor’s models', () => {
  it('lists only chat models, newest first, once each, with inferred abilities', async () => {
    const f = mockFetch([
      json({
        data: [
          { id: 'llama-3.1-8b-instant', created: 100 },
          { id: 'whisper-large-v3', created: 300 },
          { id: 'llama-3.3-70b-versatile', created: 200 },
          { id: 'llama-3.3-70b-versatile', created: 200 },
          { id: 'text-embedding-3', created: 400 },
          { id: 'bad id with spaces', created: 500 },
          { id: 'img', type: 'image', created: 600 },
          { id: 42 },
        ],
      }),
    ]);
    const models = await registry(f).get('groq').listModels();
    expect(models.map((m) => m.modelId)).toEqual([
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ]);
    expect(models[0]).toMatchObject({
      providerId: 'groq',
      capabilitySource: 'inferred',
      capabilities: { streaming: true, tools: true },
    });
    expect(models[1]!.tier).toBe('fast');
    expect(f.requests[0]!.url).toBe('https://api.groq.com/openai/v1/models');
    expect(f.requests[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(f.requests[0]!.url).not.toContain(KEY);
  });

  it('reads the two shapes servers use for the list', () => {
    expect(modelEntries({ data: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
    expect(modelEntries([{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(modelEntries({ data: 'nope' })).toEqual([]);
    expect(modelEntries(null)).toEqual([]);
  });

  it('a rejected key is an authentication error that does not contain the key', async () => {
    const f = mockFetch([json({ error: { message: `Invalid API key ${KEY}` } }, { status: 401 })]);
    const error = await registry(f)
      .get('mistral')
      .listModels()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(KEY);
  });
});

describe('a provider at an address the person chose', () => {
  it('uses the address read at request time, so a change applies at once', async () => {
    let address: string | undefined = 'http://localhost:11434/v1';
    const f = mockFetch(() => json({ data: [{ id: 'qwen2.5:7b' }] }));
    const r = registry(f, { getBaseUrl: (id: string) => (id === 'ollama' ? address : undefined) });
    await r.get('ollama').listModels();
    address = 'https://models.example.com/v1/';
    await r.get('ollama').listModels();
    address = undefined;
    await r.get('ollama').listModels();
    expect(f.requests.map((q) => q.url)).toEqual([
      'http://localhost:11434/v1/models',
      'https://models.example.com/v1/models',
      'http://localhost:11434/v1/models',
    ]);
  });

  it('other providers ignore it', async () => {
    const f = mockFetch(() => json({ data: [{ id: 'grok-3' }] }));
    const r = registry(f, { getBaseUrl: () => 'https://elsewhere.example/v1' });
    await r.get('xai').listModels();
    expect(f.requests[0]!.url).toBe('https://elsewhere.example/v1/models'); // a context-level override applies to all ids it is given
  });

  it('streams a chat reply from the server it points to', async () => {
    const f = mockFetch(() =>
      streamResponse([
        sse({ model: 'qwen2.5:7b', choices: [{ delta: { content: 'নমস্কার ' } }] }),
        sse({ choices: [{ delta: { content: 'বন্ধু' }, finish_reason: 'stop' }] }),
        sse('[DONE]'),
      ]),
    );
    const r = registry(f, { getBaseUrl: () => 'http://127.0.0.1:1234/v1' });
    const events = [];
    for await (const event of r.get('custom').stream({
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
    }))
      events.push(event);
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('নমস্কার বন্ধু');
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' });
    expect(f.requests[0]!.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(f.requests[0]!.body).toMatchObject({ model: 'qwen2.5:7b', max_tokens: 50 });
  });
});

describe('a key a service echoes back', () => {
  it('is removed from error text whatever it looks like', async () => {
    const plain = 'k3Jx9Qw2LmZp7Rt5Vb8Nc4Yh6Gd1Fa0S'; // a format no pattern knows
    const r = createProviderRegistry({
      getApiKey: async () => plain,
      fetch: mockFetch(() =>
        json({ error: { message: `Incorrect key: ${plain}` } }, { status: 401 }),
      ),
      maxRetries: 0,
    });
    const error = await r
      .get('together')
      .listModels()
      .catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('Incorrect key');
    expect(String((error as Error).message)).not.toContain(plain);
  });

  it('is removed from a network failure message too', async () => {
    const plain = 'k3Jx9Qw2LmZp7Rt5Vb8Nc4Yh6Gd1Fa0S';
    const r = createProviderRegistry({
      getApiKey: async () => plain,
      fetch: async () => {
        throw new Error(`connect failed for https://x.example/?auth=${plain}`);
      },
      maxRetries: 0,
    });
    const error = await r
      .get('together')
      .listModels()
      .catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe('PROVIDER_UNAVAILABLE');
    expect(String((error as Error).message)).not.toContain(plain);
  });

  it('Groq and xAI style keys are also caught by pattern, for logs and exports', async () => {
    const { redactString } = await import('@allaya/shared');
    expect(redactString('key gsk_abcdefghijklmnopqrstuvwx here')).toBe('key [REDACTED] here');
    expect(redactString('key xai-abcdefghijklmnopqrstuvwx here')).toBe('key [REDACTED] here');
  });
});
