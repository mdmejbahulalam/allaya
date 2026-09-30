import { AllayaError, sleep } from '@allaya/shared';
import type { ProviderId } from '@allaya/types';
import { httpError, networkError, parseRetryAfter, secretsIn } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  provider: ProviderId;
  fetch: FetchLike;
  /** Total time allowed for non-streaming requests, or time-to-first-byte for streams. */
  timeoutMs?: number;
  /** Retries for retryable failures (429/5xx/network). Never retried once bytes have streamed. */
  maxRetries?: number;
  /** Backoff base; tests set 0. */
  backoffMs?: number;
}

export interface RequestSpec {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  /** JSON-serialised request body. */
  body?: unknown;
  /** A pre-built body (e.g. `FormData` for multipart uploads). Its content type is set by fetch; do not add one. */
  rawBody?: NonNullable<RequestInit['body']>;
  signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT = 60_000;
const MAX_RETRY_WAIT = 30_000;

function combineSignals(
  user: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new AllayaError('The AI provider took too long to respond', {
          code: 'TIMEOUT',
          retryable: true,
        }),
      ),
    timeoutMs,
  );
  const onAbort = () => controller.abort(user?.reason);
  if (user?.aborted) controller.abort(user.reason);
  else user?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      user?.removeEventListener('abort', onAbort);
    },
  };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Performs a request with timeout, cancellation, bounded retry and error mapping. On success returns the
 * live `Response` (caller consumes JSON or the stream). The timeout covers time-to-first-byte only for
 * streams: `dispose()` is called by the caller when the body is finished.
 */
export async function send(
  options: HttpOptions,
  spec: RequestSpec,
): Promise<{ response: Response; dispose: () => void }> {
  const {
    provider,
    fetch: doFetch,
    timeoutMs = DEFAULT_TIMEOUT,
    maxRetries = 2,
    backoffMs = 500,
  } = options;
  let attempt = 0;
  const secrets = secretsIn(spec.headers);

  for (;;) {
    const { signal, dispose } = combineSignals(spec.signal, timeoutMs);
    try {
      const response = await doFetch(spec.url, {
        method: spec.method ?? 'POST',
        headers: spec.headers,
        ...(spec.rawBody !== undefined
          ? { body: spec.rawBody }
          : spec.body === undefined
            ? {}
            : { body: JSON.stringify(spec.body) }),
        signal,
      });
      if (response.ok) return { response, dispose };

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const error = httpError(
        provider,
        response.status,
        await readBody(response),
        retryAfter,
        secrets,
      );
      dispose();
      if (!error.retryable || attempt >= maxRetries || spec.signal?.aborted) throw error;
      // Honour Retry-After, but never stall the agent for longer than MAX_RETRY_WAIT.
      const wait =
        retryAfter === undefined
          ? backoffMs * 2 ** attempt + Math.random() * backoffMs
          : Math.min(retryAfter, MAX_RETRY_WAIT);
      await sleep(wait, spec.signal);
    } catch (error) {
      dispose();
      if (error instanceof AllayaError) {
        if (error.code === 'CANCELLED' || !error.retryable || attempt >= maxRetries) throw error;
      } else if (spec.signal?.aborted) {
        throw new AllayaError('cancelled', { code: 'CANCELLED' });
      } else if (signal.aborted && signal.reason instanceof AllayaError) {
        throw signal.reason;
      } else if (attempt >= maxRetries) {
        throw networkError(provider, error, secrets);
      } else {
        await sleep(backoffMs * 2 ** attempt + Math.random() * backoffMs, spec.signal);
      }
    }
    attempt += 1;
  }
}

export async function postJson<T>(options: HttpOptions, spec: RequestSpec): Promise<T> {
  const { response, dispose } = await send(options, spec);
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new AllayaError(`${options.provider}: the response was not valid JSON`, {
      code: 'PROVIDER_ERROR',
      cause,
    });
  } finally {
    dispose();
  }
}
