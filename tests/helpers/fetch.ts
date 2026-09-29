import type { FetchLike } from '@allaya/ai';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const encoder = new TextEncoder();

/** Builds a streaming Response whose bytes arrive in the given chunks (strings are UTF-8 encoded). */
export function streamResponse(
  chunks: Array<string | Uint8Array>,
  init: ResponseInit = { status: 200, headers: { 'content-type': 'text/event-stream' } },
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
  return new Response(body, init);
}

/** Formats one SSE event. */
export const sse = (data: unknown, event?: string): string =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/** Splits a UTF-8 string into `size`-byte chunks — deliberately cutting through multi-byte characters. */
export function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

export interface MockFetch extends FetchLike {
  requests: RecordedRequest[];
}

/** A `fetch` double that records requests and answers from a queue or a function. */
export function mockFetch(
  responder: Response[] | ((req: RecordedRequest, index: number) => Response | Promise<Response>),
): MockFetch {
  const requests: RecordedRequest[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const recorded: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(recorded);
    const index = requests.length - 1;
    if (init?.signal?.aborted)
      throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    if (typeof responder === 'function') return responder(recorded, index);
    const next = responder[Math.min(index, responder.length - 1)];
    if (!next) throw new Error('mockFetch: no response queued');
    return next.clone();
  }) as MockFetch;
  fn.requests = requests;
  return fn;
}
