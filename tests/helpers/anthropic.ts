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

/**
 * A streamed Anthropic turn that may contain text and tool calls, finishing with `stop_reason`
 * ('tool_use' when calls are present, unless overridden).
 */
export function toolUseStream(
  turn: {
    text?: string[];
    calls?: Array<{ id: string; name: string; input: unknown }>;
    stopReason?: string;
  },
  usage = { input: 20, output: 10 },
): Response {
  const events: string[] = [
    sse(
      {
        type: 'message_start',
        message: { model: SONNET, usage: { input_tokens: usage.input, output_tokens: 1 } },
      },
      'message_start',
    ),
  ];
  let index = 0;
  if (turn.text?.length) {
    events.push(
      sse(
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        'content_block_start',
      ),
    );
    for (const text of turn.text) {
      events.push(
        sse(
          { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
          'content_block_delta',
        ),
      );
    }
    events.push(sse({ type: 'content_block_stop', index }, 'content_block_stop'));
    index += 1;
  }
  for (const call of turn.calls ?? []) {
    events.push(
      sse(
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
        },
        'content_block_start',
      ),
    );
    const json = JSON.stringify(call.input);
    // Deliver the arguments in two fragments, like the real API does.
    const cut = Math.max(1, Math.floor(json.length / 2));
    for (const partial of [json.slice(0, cut), json.slice(cut)]) {
      events.push(
        sse(
          {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: partial },
          },
          'content_block_delta',
        ),
      );
    }
    events.push(sse({ type: 'content_block_stop', index }, 'content_block_stop'));
    index += 1;
  }
  const stop = turn.stopReason ?? ((turn.calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn');
  events.push(
    sse(
      {
        type: 'message_delta',
        delta: { stop_reason: stop },
        usage: { output_tokens: usage.output },
      },
      'message_delta',
    ),
  );
  events.push(sse({ type: 'message_stop' }, 'message_stop'));
  return streamResponse(events);
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
