import { describe, expect, it, vi } from 'vitest';
import { AllayaError, CancellationSource } from '@allaya/shared';
import { OpenAIProvider, httpError, parseRetryAfter, send, type ProviderContext } from '@allaya/ai';
import { json, mockFetch, sse, streamResponse } from '../../helpers/fetch';

const opts = (fetch: ReturnType<typeof mockFetch>, over = {}) => ({
  provider: 'openai' as const,
  fetch,
  backoffMs: 0,
  ...over,
});
const spec = { url: 'https://x.test/v1', headers: { a: 'b' }, body: { hi: 1 } };
const status = (
  code: number,
  body: unknown = { error: { message: 'nope' } },
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(body), { status: code, headers });

describe('HTTP error mapping', () => {
  it.each([
    [401, 'PROVIDER_AUTH_FAILED', false],
    [403, 'PROVIDER_AUTH_FAILED', false],
    [429, 'PROVIDER_RATE_LIMITED', true],
    [500, 'PROVIDER_UNAVAILABLE', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
    [529, 'PROVIDER_UNAVAILABLE', true],
    [400, 'PROVIDER_ERROR', false],
    [404, 'PROVIDER_ERROR', false],
  ] as const)('%i → %s (retryable=%s)', (code, expected, retryable) => {
    const error = httpError('openai', code, { error: { message: 'x' } });
    expect(error).toMatchObject({ code: expected, retryable });
  });

  it('never leaks a key that a provider echoes back in its error message', () => {
    const leaked = httpError('openai', 401, {
      error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwx.' },
    });
    expect(leaked.message).not.toContain('abcdefghijklmnop');
    const anthropic = httpError('anthropic', 401, {
      error: { message: 'invalid x-api-key sk-ant-api03-abcdefghijklmnop' },
    });
    expect(anthropic.message).not.toContain('abcdefghijklmnop');
  });

  it('parses Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
  });
});

describe('send(): retry policy', () => {
  it('retries 429/5xx with backoff and then succeeds', async () => {
    const f = mockFetch([status(429), status(503), json({ ok: true })]);
    const { response, dispose } = await send(opts(f, { maxRetries: 2 }), spec);
    expect(await response.json()).toEqual({ ok: true });
    dispose();
    expect(f.requests).toHaveLength(3);
  });

  it('gives up after maxRetries and reports the last error', async () => {
    const f = mockFetch([status(503)]);
    await expect(send(opts(f, { maxRetries: 1 }), spec)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(f.requests).toHaveLength(2);
  });

  it('does NOT retry auth or bad-request failures', async () => {
    for (const code of [400, 401, 403, 404]) {
      const f = mockFetch([status(code)]);
      await expect(send(opts(f, { maxRetries: 3 }), spec)).rejects.toBeInstanceOf(AllayaError);
      expect(f.requests, `status ${code}`).toHaveLength(1);
    }
  });

  it('honours a short Retry-After instead of the default backoff', async () => {
    vi.useFakeTimers();
    const f = mockFetch([status(429, {}, { 'retry-after': '1' }), json({ ok: 1 })]);
    const pending = send(opts(f, { maxRetries: 1, backoffMs: 60_000 }), spec);
    await vi.advanceTimersByTimeAsync(1000);
    const { dispose } = await pending;
    dispose();
    expect(f.requests).toHaveLength(2);
    vi.useRealTimers();
  });

  it('retries network failures, then wraps them as a typed retryable error', async () => {
    const f = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(send(opts(f, { maxRetries: 1 }), spec)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(f.requests).toHaveLength(2);
  });
});

describe('send(): cancellation and timeouts', () => {
  it('cancels immediately when the emergency stop fires mid-request', async () => {
    const source = new CancellationSource();
    const f = mockFetch(
      (_req) =>
        new Promise<Response>(() => {
          /* never resolves: simulates a hung connection */
        }),
    );
    // fetch double must honour the abort signal like the real one
    const hanging = (async (url: string, init?: RequestInit) => {
      f.requests.push({ url, method: 'POST', headers: {}, body: undefined });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), {
          once: true,
        });
      });
    }) as typeof f;
    hanging.requests = f.requests;
    const pending = send(
      { provider: 'openai', fetch: hanging, maxRetries: 3, backoffMs: 0 },
      { ...spec, signal: source.signal },
    );
    source.cancel('emergency stop');
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.requests).toHaveLength(1); // cancelled requests are never retried
  });

  it('a cancelled signal never issues a request', async () => {
    const source = new CancellationSource();
    source.cancel();
    const f = mockFetch([json({})]);
    await expect(send(opts(f), { ...spec, signal: source.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('times out a request that never answers, as a retryable TIMEOUT', async () => {
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), {
          once: true,
        });
      })) as ReturnType<typeof mockFetch>;
    hanging.requests = [];
    await expect(
      send(
        { provider: 'openai', fetch: hanging, timeoutMs: 30, maxRetries: 0, backoffMs: 0 },
        spec,
      ),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
  });

  it('cancelling mid-stream stops the provider stream promptly', async () => {
    const source = new CancellationSource();
    const context: ProviderContext = {
      getApiKey: async () => 'k',
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(sse({ choices: [{ delta: { content: 'hi' } }] })),
            );
            init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), {
              once: true,
            });
          },
        });
        return new Response(body, { status: 200 });
      },
    };
    const iterator = new OpenAIProvider(context).stream(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      source.signal,
    );
    expect((await iterator.next()).value).toMatchObject({ type: 'start' });
    expect((await iterator.next()).value).toMatchObject({ type: 'text_delta', text: 'hi' });
    source.cancel('stop');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('providers: connection test', () => {
  it('reports success with latency and model count, and failures as data (never throws)', async () => {
    const ok = mockFetch([json({ data: [{ id: 'gpt-4o' }, { id: 'whisper-1' }] })]);
    expect(
      await new OpenAIProvider({
        getApiKey: async () => 'k',
        fetch: ok,
        maxRetries: 0,
      }).testConnection(),
    ).toMatchObject({ ok: true, modelCount: 1 });

    const bad = mockFetch([
      status(401, {
        error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwx' },
      }),
    ]);
    const result = await new OpenAIProvider({
      getApiKey: async () => 'k',
      fetch: bad,
      maxRetries: 0,
    }).testConnection();
    expect(result).toMatchObject({ ok: false, errorCode: 'PROVIDER_AUTH_FAILED' });
    expect(result.errorMessage).not.toContain('abcdefghijklmnop');
  });

  it('a missing key surfaces PROVIDER_NOT_CONFIGURED from the vault, not a network call', async () => {
    const f = mockFetch([json({})]);
    const provider = new OpenAIProvider({
      getApiKey: async () => {
        throw new AllayaError('No key', { code: 'PROVIDER_NOT_CONFIGURED' });
      },
      fetch: f,
    });
    expect(await provider.testConnection()).toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_NOT_CONFIGURED',
    });
    expect(f.requests).toHaveLength(0);
  });
});

void streamResponse;
