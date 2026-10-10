import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '@allaya/ai';
import type { ConnectionView, ModelList, TestResult } from '@lite/shared/ipc';
import { API_KEY, SONNET, HAIKU, modelsResponse } from '../helpers/anthropic';
import { json } from '../helpers/fetch';
import { FakeCipher } from '../helpers/cipher';
import { createLiteBackend, data, failure, type LiteBackend } from './helpers/backend';

const backends: LiteBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
});
const boot = (options: Parameters<typeof createLiteBackend>[0] = {}) => {
  const b = createLiteBackend(options);
  backends.push(b);
  return b;
};

/** A fetch that answers model lists like each service would, and records where it was asked. */
function services() {
  const asked: Array<{ url: string; auth: string }> = [];
  const fetch: FetchLike = (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    asked.push({ url, auth: headers['authorization'] ?? headers['x-api-key'] ?? '' });
    if (url.startsWith('https://api.anthropic.com/v1/models'))
      return Promise.resolve(modelsResponse());
    if (url === 'https://api.groq.com/openai/v1/models') {
      return Promise.resolve(
        json({
          data: [
            { id: 'llama-3.3-70b-versatile', created: 2 },
            { id: 'whisper-large-v3', created: 1 },
          ],
        }),
      );
    }
    if (url === 'http://localhost:11434/v1/models') {
      return Promise.resolve(json({ data: [{ id: 'llama3.2', created: 1 }] }));
    }
    if (url.startsWith('https://api.perplexity.ai')) {
      return Promise.resolve(json({ error: { message: 'not found' } }, { status: 404 }));
    }
    return Promise.resolve(json({ error: { message: 'nope' } }, { status: 401 }));
  };
  return { fetch, asked };
}

describe('connecting an AI service', () => {
  it('lists the services Allaya knows, from Claude to a model on this computer', async () => {
    const { PRESETS } = await import('@lite/shared/presets');
    const ids = PRESETS.map((p) => p.id);
    for (const id of [
      'anthropic',
      'openai',
      'google',
      'openrouter',
      'groq',
      'mistral',
      'deepseek',
      'xai',
      'ollama',
      'lmstudio',
      'custom',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PRESETS) {
      if (p.kind === 'compatible' && p.id !== 'custom') expect(p.baseUrl).toMatch(/^https?:\/\//);
    }
  });

  it('adds a service with its key, keeps the key encrypted, and shows only a hint', async () => {
    const b = boot({ fetch: services().fetch });
    const added = data<ConnectionView>(
      await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY }),
    );
    expect(added).toMatchObject({
      kind: 'anthropic',
      name: 'Anthropic (Claude)',
      hasKey: true,
      keyOptional: false,
    });
    expect(added.keyHint).toBe(`sk-…${API_KEY.slice(-4)}`);
    expect(JSON.stringify(added)).not.toContain(API_KEY);
    const raw = b.db.prepare('select enc from secrets').all() as Array<{ enc: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0]!.enc).not.toContain(API_KEY);
    expect(raw[0]!.enc.startsWith('enc:')).toBe(true);
    expect(data<ConnectionView[]>(await b.call('connections:list'))).toHaveLength(1);
  });

  it('needs a key unless the model is on this computer, and refuses a badly formed one', async () => {
    const b = boot();
    expect(failure(await b.call('connections:add', { presetId: 'anthropic' })).details).toEqual({
      reason: 'key_required',
    });
    expect(
      failure(await b.call('connections:add', { presetId: 'anthropic', apiKey: 'short' })).details,
    ).toEqual({ reason: 'bad_key' });
    expect(
      failure(
        await b.call('connections:add', { presetId: 'anthropic', apiKey: 'has a space inside it' }),
      ).details,
    ).toEqual({ reason: 'bad_key' });
    expect(
      failure(await b.call('connections:add', { presetId: 'nope', apiKey: API_KEY })).details,
    ).toEqual({ reason: 'unknown_preset' });
    const local = data<ConnectionView>(await b.call('connections:add', { presetId: 'ollama' }));
    expect(local).toMatchObject({
      hasKey: false,
      keyOptional: true,
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(data<ConnectionView[]>(await b.call('connections:list'))).toHaveLength(1);
  });

  it('refuses secure storage that is not there, and adds nothing', async () => {
    const b = boot({ cipher: new FakeCipher(false) });
    const result = await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY });
    expect(failure(result).code).toBe('CREDENTIAL_STORAGE_UNAVAILABLE');
    expect(data<ConnectionView[]>(await b.call('connections:list'))).toEqual([]);
  });

  it('adds any OpenAI-compatible address — but a key never crosses a network unencrypted', async () => {
    const b = boot();
    const mine = data<ConnectionView>(
      await b.call('connections:add', {
        presetId: 'custom',
        name: 'My server',
        baseUrl: 'https://llm.example.com/v1/',
        apiKey: API_KEY,
      }),
    );
    expect(mine).toMatchObject({
      name: 'My server',
      baseUrl: 'https://llm.example.com/v1',
      kind: 'compatible',
    });
    const insecure = await b.call('connections:add', {
      presetId: 'custom',
      name: 'Plain',
      baseUrl: 'http://llm.example.com/v1',
      apiKey: API_KEY,
    });
    expect(failure(insecure).details).toEqual({ reason: 'insecure_remote' });
    expect(
      failure(await b.call('connections:add', { presetId: 'custom', name: 'x', apiKey: API_KEY }))
        .details,
    ).toEqual({ reason: 'empty' });
  });

  it('changes a name, address or key, and removes a service with its key', async () => {
    const b = boot();
    const added = data<ConnectionView>(
      await b.call('connections:add', { presetId: 'groq', apiKey: API_KEY }),
    );
    const renamed = data<ConnectionView>(
      await b.call('connections:update', {
        id: added.id,
        name: 'Fast one',
        apiKey: 'gsk_another_key_value',
      }),
    );
    expect(renamed.name).toBe('Fast one');
    expect(b.secrets.get(`llm:${added.id}`)).toBe('gsk_another_key_value');
    expect(data(await b.call('connections:remove', { id: added.id }))).toEqual({ ok: true });
    expect(b.secrets.has(`llm:${added.id}`)).toBe(false);
    expect(failure(await b.call('connections:remove', { id: added.id })).code).toBe('NOT_FOUND');
  });

  it('announces a change so the screen stays true', async () => {
    const b = boot();
    await b.call('connections:add', { presetId: 'groq', apiKey: API_KEY });
    expect(b.events.of('connections:changed')).toHaveLength(1);
  });
});

describe('the models a service offers', () => {
  it('are read from the service itself, with the key it was given', async () => {
    const s = services();
    const b = boot({ fetch: s.fetch });
    const added = data<ConnectionView>(
      await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY }),
    );
    const list = data<ModelList>(await b.call('models:list', {}));
    expect(list.problems).toEqual([]);
    expect(list.models.map((m) => m.modelId).sort()).toEqual([HAIKU, SONNET].sort());
    expect(list.models[0]).toMatchObject({
      connectionId: added.id,
      connectionName: 'Anthropic (Claude)',
    });
    expect(s.asked[0]!.auth).toBe(API_KEY);
  });

  it('come from every service, in the order they were added, speech models left out', async () => {
    const b = boot({ fetch: services().fetch });
    await b.call('connections:add', { presetId: 'groq', apiKey: API_KEY });
    await b.call('connections:add', { presetId: 'ollama' });
    const list = data<ModelList>(await b.call('models:list', {}));
    expect(list.models.map((m) => `${m.connectionName}:${m.modelId}`)).toEqual([
      'Groq:llama-3.3-70b-versatile',
      'Ollama (on this computer):llama3.2',
    ]);
  });

  it('are kept a few minutes, and read again when asked', async () => {
    const s = services();
    const b = boot({ fetch: s.fetch });
    await b.call('connections:add', { presetId: 'groq', apiKey: API_KEY });
    await b.call('models:list', {});
    await b.call('models:list', {});
    expect(s.asked.filter((a) => a.url.endsWith('/models'))).toHaveLength(1);
    await b.call('models:list', { refresh: true });
    expect(s.asked.filter((a) => a.url.endsWith('/models'))).toHaveLength(2);
  });

  it('say which service failed and why, without hiding the others', async () => {
    const b = boot({ fetch: services().fetch });
    await b.call('connections:add', { presetId: 'groq', apiKey: API_KEY });
    await b.call('connections:add', { presetId: 'mistral', apiKey: API_KEY });
    const list = data<ModelList>(await b.call('models:list', {}));
    expect(list.models.map((m) => m.connectionName)).toEqual(['Groq']);
    expect(list.problems).toHaveLength(1);
    expect(list.problems[0]!.connectionName).toBe('Mistral');
    expect(list.problems[0]!.message).not.toContain(API_KEY);
  });

  it('can be typed in for a service that has no list', async () => {
    const b = boot({ fetch: services().fetch });
    await b.call('connections:add', {
      presetId: 'perplexity',
      apiKey: API_KEY,
      manualModels: ['sonar', 'sonar-pro'],
    });
    const list = data<ModelList>(await b.call('models:list', {}));
    expect(list.models.map((m) => m.modelId)).toEqual(['sonar', 'sonar-pro']);
    expect(list.problems).toEqual([]);
    const none = boot({ fetch: services().fetch });
    await none.call('connections:add', { presetId: 'perplexity', apiKey: API_KEY });
    expect(data<ModelList>(await none.call('models:list', {})).problems).toHaveLength(1);
  });

  it('a service tested with a wrong key says so', async () => {
    const b = boot({ fetch: services().fetch });
    const added = data<ConnectionView>(
      await b.call('connections:add', { presetId: 'xai', apiKey: API_KEY }),
    );
    const result = data<TestResult>(await b.call('connections:test', { id: added.id }));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_AUTH_FAILED');
    const good = data<ConnectionView>(
      await b.call('connections:add', { presetId: 'groq', apiKey: API_KEY }),
    );
    expect(data<TestResult>(await b.call('connections:test', { id: good.id }))).toMatchObject({
      ok: true,
      modelCount: 1,
    });
  });
});
