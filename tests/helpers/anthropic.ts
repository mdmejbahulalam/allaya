import { json, sse, streamResponse } from './fetch';

export const SONNET = 'claude-sonnet-5-5';
export const HAIKU = 'claude-haiku-4-5-20251001';
export const API_KEY = 'sk-ant-api03-SECRETSECRETSECRETSECRET';

export const modelsResponse = () =>
  json({
    data: [
      {
        id: SONNET,
        display_name: 'Claude Sonnet 5.5',
        max_input_tokens: 200_000,
        max_tokens: 64_000,
      },
      { id: HAIKU, display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000, max_tokens: 8_192 },
    ],
  });

/** A complete Anthropic streaming reply that delivers `text` in the given pieces. */
export function replyStream(pieces: string[], usage = { input: 20, output: 10 }): Response {
  return streamResponse([
    sse(
      {
        type: 'message_start',
        message: { model: SONNET, usage: { input_tokens: usage.input, output_tokens: 1 } },
      },
      'message_start',
    ),
    sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'content_block_start',
    ),
    ...pieces.map((text) =>
      sse(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        'content_block_delta',
      ),
    ),
    sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
    sse(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: usage.output },
      },
      'message_delta',
    ),
    sse({ type: 'message_stop' }, 'message_stop'),
  ]);
}

/** A reply that starts, then never finishes until the request is aborted (for cancellation tests). */
export function hangingStream(firstText: string, signal: AbortSignal | undefined): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          sse(
            { type: 'message_start', message: { model: SONNET, usage: { input_tokens: 5 } } },
            'message_start',
          ),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sse(
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            'content_block_start',
          ),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sse(
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: firstText },
            },
            'content_block_delta',
          ),
        ),
      );
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200 });
}

export const authError = () =>
  new Response(
    JSON.stringify({
      error: { type: 'authentication_error', message: `invalid x-api-key ${API_KEY}` },
    }),
    { status: 401 },
  );
