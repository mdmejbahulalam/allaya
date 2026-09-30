import { afterEach, describe, expect, it } from 'vitest';
import { API_KEY, HAIKU, SONNET, authError, modelsResponse } from '../helpers/anthropic';
import { mockFetch } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';

let backend: TestBackend;
afterEach(() => backend?.dispose());

const rawRows = (b: TestBackend, table: string) =>
  b.container.database.raw.prepare(`SELECT * FROM ${table}`).all() as Array<
    Record<string, unknown>
  >;

describe('provider setup', () => {
  it('starts with every provider unconfigured (no-API-key mode) and no models', async () => {
    backend = createTestBackend();
    const result = await backend.call('providers:list');
    expect(result.ok && result.data).toHaveLength(11);
    for (const provider of (result as { data: Array<{ status: string; models: unknown[] }> })
      .data) {
      expect(provider.status).toBe('not_configured');
      expect(provider.models).toEqual([]);
    }
    expect(await backend.call('models:list')).toMatchObject({ ok: true, data: [] });
  });

  it('saves a key, verifies it, discovers models — and never exposes or stores the plaintext key', async () => {
    const f = mockFetch([modelsResponse()]);
    backend = createTestBackend({ fetch: f });
    const result = await backend.call('providers:setKey', {
      providerId: 'anthropic',
      apiKey: API_KEY,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { id: 'anthropic', status: 'connected', maskedKey: 'sk-…CRET' },
    });
    const view = (result as { data: { models: Array<{ modelId: string }> } }).data;
    expect(view.models.map((m) => m.modelId)).toEqual([SONNET, HAIKU]);

    // The key reached the provider as a header only.
    expect(f.requests[0]!.headers['x-api-key']).toBe(API_KEY);
    expect(f.requests[0]!.url).not.toContain('SECRET');

    // Nothing the renderer can see, nothing on disk, and nothing in the logs contains the key.
    expect(JSON.stringify(result)).not.toContain('SECRETSECRET');
    expect(JSON.stringify(rawRows(backend, 'api_credentials'))).not.toContain('SECRETSECRET');
    expect(rawRows(backend, 'api_credentials')[0]!['encrypted_key']).toMatch(/^enc:/);
    expect(JSON.stringify(backend.logs.records)).not.toContain('SECRETSECRET');
    expect(JSON.stringify(backend.events.events)).not.toContain('SECRETSECRET');

    expect(backend.eventsOf('providers:changed')).toHaveLength(1);
    expect((await backend.call('models:list')) as { data: unknown[] }).toMatchObject({
      data: [{ providerId: 'anthropic' }, { providerId: 'anthropic' }],
    });
  });

  it('a key the provider rejects is NOT kept, and the error does not echo it', async () => {
    backend = createTestBackend({ fetch: mockFetch([authError()]) });
    const result = await backend.call('providers:setKey', {
      providerId: 'anthropic',
      apiKey: API_KEY,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_AUTH_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('SECRETSECRET');
    expect(rawRows(backend, 'api_credentials')).toHaveLength(0);
    expect(rawRows(backend, 'models')).toHaveLength(0);
    const list = (await backend.call('providers:list')) as {
      data: Array<{ id: string; status: string; maskedKey?: string }>;
    };
    expect(list.data.find((p) => p.id === 'anthropic')).toMatchObject({ status: 'not_configured' });
    expect(list.data.find((p) => p.id === 'anthropic')!.maskedKey).toBeUndefined();
  });

  it('an unreachable provider keeps the key (user may be offline) but reports status "error"', async () => {
    backend = createTestBackend({
      fetch: mockFetch(() => {
        throw new TypeError('fetch failed');
      }),
    });
    const result = await backend.call('providers:setKey', {
      providerId: 'anthropic',
      apiKey: API_KEY,
    });
    expect(result).toMatchObject({ ok: true, data: { status: 'error', maskedKey: 'sk-…CRET' } });
    expect(rawRows(backend, 'api_credentials')).toHaveLength(1);
    expect((await backend.call('models:list')) as { data: unknown[] }).toEqual({
      ok: true,
      data: [],
    }); // not usable until verified
  });

  it('refuses to store anything when the OS cannot encrypt', async () => {
    backend = createTestBackend({ fetch: mockFetch([modelsResponse()]), cipherAvailable: false });
    const result = await backend.call('providers:setKey', {
      providerId: 'anthropic',
      apiKey: API_KEY,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_STORAGE_UNAVAILABLE' } });
    expect(rawRows(backend, 'api_credentials')).toHaveLength(0);
  });

  it('the IPC boundary rejects malformed keys before any service runs', async () => {
    backend = createTestBackend({ fetch: mockFetch([modelsResponse()]) });
    for (const apiKey of ['short', 'has\nnewline-abcdefgh', 'x'.repeat(601), 42, null]) {
      const result = await backend.call('providers:setKey', { providerId: 'anthropic', apiKey });
      expect(result, String(apiKey)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_IPC_PAYLOAD' },
      });
    }
    expect(
      await backend.call('providers:setKey', { providerId: 'not-a-provider', apiKey: API_KEY }),
    ).toMatchObject({ ok: false });
    expect(rawRows(backend, 'api_credentials')).toHaveLength(0);
  });

  it('remove clears key, models and routing; test requires a key', async () => {
    backend = createTestBackend({ fetch: mockFetch([modelsResponse()]) });
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
    await backend.call('models:setRouting', {
      assignments: { coding: { providerId: 'anthropic', modelId: SONNET } },
    });
    const removed = await backend.call('providers:removeKey', { providerId: 'anthropic' });
    expect(removed).toMatchObject({ ok: true, data: { status: 'not_configured', models: [] } });
    expect(rawRows(backend, 'api_credentials')).toHaveLength(0);
    expect(
      ((await backend.call('models:getRouting')) as { data: { assignments: object } }).data
        .assignments,
    ).toEqual({});
    expect(await backend.call('providers:test', { providerId: 'anthropic' })).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_NOT_CONFIGURED' },
    });
  });

  it('connection test reports latency and refreshes models', async () => {
    backend = createTestBackend({ fetch: mockFetch([modelsResponse()]) });
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
    const result = await backend.call('providers:test', { providerId: 'anthropic' });
    expect(result).toMatchObject({
      ok: true,
      data: { result: { ok: true, modelCount: 2 }, provider: { status: 'connected' } },
    });
  });
});

describe('model routing over IPC', () => {
  const connect = async () => {
    backend = createTestBackend({ fetch: mockFetch([modelsResponse()]) });
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
  };

  it('persists assignments and the auto-routing toggle', async () => {
    await connect();
    const set = await backend.call('models:setRouting', {
      autoRouting: false,
      assignments: {
        coding: { providerId: 'anthropic', modelId: SONNET },
        fast: { providerId: 'anthropic', modelId: HAIKU },
      },
    });
    expect(set).toMatchObject({
      ok: true,
      data: {
        autoRouting: false,
        assignments: { coding: { modelId: SONNET }, fast: { modelId: HAIKU } },
      },
    });
    expect(backend.container.settings.get('ai.autoRouting')).toBe(false);
    // null clears one assignment
    const cleared = await backend.call('models:setRouting', { assignments: { coding: null } });
    expect(
      (cleared as { data: { assignments: Record<string, unknown> } }).data.assignments,
    ).not.toHaveProperty('coding');
    expect(
      (cleared as { data: { assignments: Record<string, unknown> } }).data.assignments,
    ).toHaveProperty('fast');
  });

  it('rejects assigning a model that no connected provider offers', async () => {
    await connect();
    expect(
      await backend.call('models:setRouting', {
        assignments: { vision: { providerId: 'openai', modelId: 'gpt-4o' } },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(
      await backend.call('models:setRouting', {
        assignments: { vision: { providerId: 'anthropic', modelId: 'made-up' } },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await backend.call('models:setRouting', {
        assignments: { not_a_purpose: { providerId: 'anthropic', modelId: SONNET } },
      }),
    ).toMatchObject({ ok: false });
  });
});
