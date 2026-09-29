import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  collectStream,
  sanitizeGeminiSchema,
  toAnthropicMessages,
  toGeminiContents,
  toOpenAIMessages,
  type AIRequest,
  type ProviderContext,
  type StreamEvent,
} from '@allaya/ai';
import { byteChunks, json, mockFetch, sse, streamResponse } from '../../helpers/fetch';

const ctx = (
  fetch: ProviderContext['fetch'],
  extra: Partial<ProviderContext> = {},
): ProviderContext => ({
  getApiKey: async () => 'test-key-1234567890',
  fetch,
  maxRetries: 0,
  backoffMs: 0,
  ...extra,
});

const openFolderTool = {
  name: 'open_folder',
  description: 'Open a folder',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' } },
    required: ['target'],
    additionalProperties: false,
  },
};

// ── Anthropic ───────────────────────────────────────────────────────────────
describe('Anthropic adapter', () => {
  const stream = (parts: string[]) =>
    streamResponse([
      sse(
        {
          type: 'message_start',
          message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 25, output_tokens: 1 } },
        },
        'message_start',
      ),
      ...parts,
      sse({ type: 'message_stop' }, 'message_stop'),
    ]);

  it('streams text with usage and maps stop reasons', async () => {
    const f = mockFetch([
      stream([
        sse(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          'content_block_start',
        ),
        sse(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'হয়ে ' } },
          'content_block_delta',
        ),
        sse(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'গেছে' } },
          'content_block_delta',
        ),
        sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
        sse({ type: 'ping' }, 'ping'),
        sse(
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 12 },
          },
          'message_delta',
        ),
      ]),
    ]);
    const res = await new AnthropicProvider(ctx(f)).complete({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res).toMatchObject({
      text: 'হয়ে গেছে',
      finishReason: 'stop',
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 25, outputTokens: 12 },
    });
  });

  it('assembles a tool call from partial JSON fragments and finishes with tool_calls', async () => {
    const f = mockFetch([
      stream([
        sse(
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_01', name: 'open_folder', input: {} },
          },
          'content_block_start',
        ),
        sse(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"tar' },
          },
          'content_block_delta',
        ),
        sse(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'get": "Down' },
          },
          'content_block_delta',
        ),
        sse(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'loads"}' },
          },
          'content_block_delta',
        ),
        sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
        sse(
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 30 },
          },
          'message_delta',
        ),
      ]),
    ]);
    const res = await new AnthropicProvider(ctx(f)).complete({
      model: 'm',
      messages: [{ role: 'user', content: 'open downloads' }],
      tools: [openFolderTool],
    });
    expect(res.toolCalls).toEqual([
      { id: 'toolu_01', name: 'open_folder', arguments: { target: 'Downloads' } },
    ]);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('a tool with no arguments yields an empty object, not an error', async () => {
    const f = mockFetch([
      stream([
        sse(
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 't', name: 'take_screenshot', input: {} },
          },
          'content_block_start',
        ),
        sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
        sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, 'message_delta'),
      ]),
    ]);
    const res = await new AnthropicProvider(ctx(f)).complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.toolCalls[0]!.arguments).toEqual({});
  });

  it('malformed tool JSON becomes a retryable typed error (never guessed or repaired)', async () => {
    const f = mockFetch([
      stream([
        sse(
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 't', name: 'open_folder', input: {} },
          },
          'content_block_start',
        ),
        sse(
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"target": ' },
          },
          'content_block_delta',
        ),
        sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
      ]),
    ]);
    await expect(
      new AnthropicProvider(ctx(f)).complete({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: true,
    });
  });

  it('sends the key as x-api-key with the pinned API version, never in the URL or body', async () => {
    const f = mockFetch([
      stream([sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 'message_delta')]),
    ]);
    await new AnthropicProvider(ctx(f)).complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    const req = f.requests[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('test-key-1234567890');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.url).not.toContain('test-key');
    expect(JSON.stringify(req.body)).not.toContain('test-key');
    expect(req.body).toMatchObject({ stream: true, max_tokens: 4096 });
  });

  it('maps a mid-stream error event to a typed error', async () => {
    const f = mockFetch([
      stream([
        sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'),
      ]),
    ]);
    await expect(
      new AnthropicProvider(ctx(f)).complete({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('translates messages: tool results first, empty text dropped, same-role turns merged', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'open downloads' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '  ' },
          { type: 'tool_call', id: 'c1', name: 'open_folder', arguments: { target: 'Downloads' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'thanks' },
          { type: 'tool_result', toolCallId: 'c1', content: 'opened' },
        ],
      },
      { role: 'user', content: 'and also…' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[1]!.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'open_folder', input: { target: 'Downloads' } },
    ]);
    expect(out[2]!.role).toBe('user');
    expect(out[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' });
    expect(out[2]!.content.map((b) => b.type)).toEqual(['tool_result', 'text', 'text']);
  });

  it('lists models and prefers provider-published capabilities over inference', async () => {
    const f = mockFetch([
      json({
        data: [
          {
            id: 'claude-sonnet-5-5',
            display_name: 'Claude Sonnet 5.5',
            max_input_tokens: 1_000_000,
            max_tokens: 64_000,
            capabilities: { image_input: { supported: true }, thinking: { supported: true } },
          },
          { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
          { id: 'not-a-claude-model' },
        ],
      }),
    ]);
    const models = await new AnthropicProvider(ctx(f)).listModels();
    expect(models.map((m) => m.modelId)).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect(models[0]).toMatchObject({
      capabilitySource: 'provider',
      capabilities: {
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        vision: true,
        reasoning: true,
      },
    });
    expect(models[1]).toMatchObject({ capabilitySource: 'inferred', tier: 'fast' });
    expect(f.requests[0]!.method).toBe('GET');
  });
});

// ── OpenAI / OpenRouter ─────────────────────────────────────────────────────
describe('OpenAI-compatible adapters', () => {
  const chunk = (delta: object, finish: string | null = null, extra: object = {}) =>
    sse({ model: 'gpt-x', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

  it('streams text; usage arrives after the finish chunk and before [DONE]', async () => {
    const f = mockFetch([
      streamResponse([
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Done — ' }),
        chunk({ content: 'Chrome is open.' }),
        chunk({}, 'stop'),
        sse({ model: 'gpt-x', choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } }),
        'data: [DONE]\n\n',
      ]),
    ]);
    const res = await new OpenAIProvider(ctx(f)).complete({
      model: 'gpt-x',
      system: 'be brief',
      messages: [{ role: 'user', content: 'open chrome' }],
      maxTokens: 100,
    });
    expect(res).toMatchObject({
      text: 'Done — Chrome is open.',
      finishReason: 'stop',
      usage: { inputTokens: 40, outputTokens: 9 },
    });
    const body = f.requests[0]!.body as Record<string, unknown>;
    expect(f.requests[0]!.headers['authorization']).toBe('Bearer test-key-1234567890');
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 100,
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect((body['messages'] as Array<{ role: string }>)[0]!.role).toBe('system');
  });

  it('assembles parallel tool calls from fragments interleaved by index', async () => {
    const f = mockFetch([
      streamResponse([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'open_folder', arguments: '' },
            },
          ],
        }),
        chunk({
          tool_calls: [
            {
              index: 1,
              id: 'call_b',
              type: 'function',
              function: { name: 'take_screenshot', arguments: '' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"target":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Downloads"}' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{}' } }] }),
        chunk({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    ]);
    const res = await new OpenAIProvider(ctx(f)).complete({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'x' }],
      tools: [openFolderTool],
    });
    expect(res.toolCalls).toEqual([
      { id: 'call_a', name: 'open_folder', arguments: { target: 'Downloads' } },
      { id: 'call_b', name: 'take_screenshot', arguments: {} },
    ]);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('a stream that ends with no finish and no [DONE] is an error, not a silent truncation', async () => {
    const f = mockFetch([streamResponse([chunk({ content: 'partial' })])]);
    await expect(
      new OpenAIProvider(ctx(f)).complete({
        model: 'gpt-x',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('reasoning models omit temperature; OpenRouter uses max_tokens and its own base URL', async () => {
    const ok = () => streamResponse([chunk({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
    const f1 = mockFetch([ok()]);
    await new OpenAIProvider(ctx(f1)).complete({
      model: 'o3-mini',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.2,
    });
    expect(f1.requests[0]!.body).not.toHaveProperty('temperature');

    const f2 = mockFetch([ok()]);
    await new OpenAIProvider(ctx(f2)).complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.2,
    });
    expect(f2.requests[0]!.body).toMatchObject({ temperature: 0.2 });

    const f3 = mockFetch([ok()]);
    await new OpenRouterProvider(ctx(f3)).complete({
      model: 'meta/llama',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 50,
    });
    expect(f3.requests[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(f3.requests[0]!.body).toMatchObject({ max_tokens: 50 });
    expect(f3.requests[0]!.headers['x-title']).toBe('Allaya');
  });

  it('tolerates OpenRouter comment keep-alives and reports mid-stream errors', async () => {
    const f = mockFetch([
      streamResponse([
        ': OPENROUTER PROCESSING\n\n',
        chunk({ content: 'hi' }, 'stop'),
        'data: [DONE]\n\n',
      ]),
    ]);
    expect(
      (
        await new OpenRouterProvider(ctx(f)).complete({
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
        })
      ).text,
    ).toBe('hi');

    const g = mockFetch([
      streamResponse([sse({ error: { message: 'Provider returned error', type: 'upstream' } })]),
    ]);
    await expect(
      new OpenRouterProvider(ctx(g)).complete({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('decodes a Bengali stream delivered one byte at a time', async () => {
    const text =
      sse({ choices: [{ delta: { content: 'আমি ঠিক বুঝতে পারিনি।' }, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n';
    const f = mockFetch([streamResponse(byteChunks(text, 1))]);
    expect(
      (
        await new OpenAIProvider(ctx(f)).complete({
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
        })
      ).text,
    ).toBe('আমি ঠিক বুঝতে পারিনি।');
  });

  it('translates history: tool results become tool-role messages; assistant tool_calls carry JSON strings', () => {
    const out = toOpenAIMessages('sys', [
      { role: 'user', content: 'open downloads' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Opening.' },
          { type: 'tool_call', id: 'c1', name: 'open_folder', arguments: { target: 'Downloads' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'c1', content: 'opened' },
          { type: 'text', text: 'ok' },
          { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
        ],
      },
    ]);
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out[2]).toMatchObject({
      role: 'assistant',
      content: 'Opening.',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'open_folder', arguments: '{"target":"Downloads"}' },
        },
      ],
    });
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'opened' });
    expect(out[4]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
  });

  it('OpenRouter model discovery uses published metadata, pricing and modalities', async () => {
    const f = mockFetch([
      json({
        data: [
          {
            id: 'vendor/big',
            name: 'Big',
            context_length: 200_000,
            pricing: { prompt: '0.000015', completion: '0.000075' },
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            supported_parameters: ['tools', 'reasoning'],
          },
          {
            id: 'vendor/tiny',
            pricing: { prompt: '0.0000001', completion: '0.0000004' },
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: [],
          },
          { id: 'vendor/painter', architecture: { output_modalities: ['image'] } },
        ],
      }),
    ]);
    const models = await new OpenRouterProvider(ctx(f)).listModels();
    expect(models.map((m) => m.modelId)).toEqual(['vendor/big', 'vendor/tiny']);
    expect(models[0]).toMatchObject({
      tier: 'frontier',
      cost: { inputPerMTok: 15 },
      capabilities: { vision: true, tools: true, reasoning: true, contextWindow: 200_000 },
    });
    expect(models[1]).toMatchObject({
      tier: 'fast',
      capabilities: { vision: false, tools: false },
    });
  });
});

// ── Google ──────────────────────────────────────────────────────────────────
describe('Google adapter', () => {
  const part = (parts: object[], finishReason?: string, extra: object = {}) =>
    sse({
      candidates: [
        { content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) },
      ],
      ...extra,
    });

  it('streams text and usage; key is a header, never in the URL', async () => {
    const f = mockFetch([
      streamResponse([
        part([{ text: 'অবশ্যই। ' }]),
        part([{ text: 'Chrome খুলছি।' }], 'STOP', {
          usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 7 },
        }),
      ]),
    ]);
    const res = await new GoogleProvider(ctx(f)).complete({
      model: 'models/gemini-x',
      system: 'reply in Bengali',
      messages: [{ role: 'user', content: 'Chrome খুলো' }],
      maxTokens: 200,
    });
    expect(res).toMatchObject({
      text: 'অবশ্যই। Chrome খুলছি।',
      finishReason: 'stop',
      usage: { inputTokens: 18, outputTokens: 7 },
    });
    const req = f.requests[0]!;
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse',
    );
    expect(req.url).not.toContain('test-key');
    expect(req.headers['x-goog-api-key']).toBe('test-key-1234567890');
    expect(req.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'reply in Bengali' }] },
      generationConfig: { maxOutputTokens: 200 },
    });
  });

  it('turns function calls into tool calls with synthesized unique ids and finishes with tool_calls', async () => {
    const f = mockFetch([
      streamResponse([
        part(
          [
            { functionCall: { name: 'open_folder', args: { target: 'Downloads' } } },
            { functionCall: { name: 'take_screenshot', args: {} } },
          ],
          'STOP',
        ),
      ]),
    ]);
    const res = await new GoogleProvider(ctx(f)).complete({
      model: 'gemini-x',
      messages: [{ role: 'user', content: 'x' }],
      tools: [openFolderTool],
    });
    expect(res.toolCalls.map((c) => c.name)).toEqual(['open_folder', 'take_screenshot']);
    expect(new Set(res.toolCalls.map((c) => c.id)).size).toBe(2);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('maps safety blocks to content_filter, including a blocked prompt with no candidates', async () => {
    const f = mockFetch([streamResponse([sse({ promptFeedback: { blockReason: 'SAFETY' } })])]);
    expect(
      (
        await new GoogleProvider(ctx(f)).complete({
          model: 'gemini-x',
          messages: [{ role: 'user', content: 'x' }],
        })
      ).finishReason,
    ).toBe('content_filter');
    const g = mockFetch([streamResponse([part([{ text: 'x' }], 'SAFETY')])]);
    expect(
      (
        await new GoogleProvider(ctx(g)).complete({
          model: 'gemini-x',
          messages: [{ role: 'user', content: 'x' }],
        })
      ).finishReason,
    ).toBe('content_filter');
  });

  it('maps function results back by NAME (Gemini has no call ids) and merges consecutive turns', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'open it' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: 'gemini_call_1',
            name: 'open_folder',
            arguments: { target: 'Downloads' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'gemini_call_1', content: 'opened' }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'gemini_call_1', content: 'boom', isError: true },
        ],
      },
    ]);
    expect(contents).toHaveLength(3);
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'open_folder', args: { target: 'Downloads' } } }],
    });
    expect(contents[2]!.parts).toEqual([
      { functionResponse: { name: 'open_folder', response: { result: 'opened' } } },
      { functionResponse: { name: 'open_folder', response: { error: 'boom' } } },
    ]);
  });

  it('sanitizes JSON Schema into the Gemini dialect', () => {
    expect(
      sanitizeGeminiSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: ['string', 'null'], default: 'x', title: 'Name' },
          mode: { const: 'fast' },
          count: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
          tags: { type: 'array', items: { type: 'string', additionalProperties: false } },
        },
        required: ['name'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', nullable: true },
        mode: { enum: ['fast'] },
        count: { type: 'integer', minimum: 1, nullable: true },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    });
  });

  it('omits `parameters` for zero-argument tools (Gemini rejects empty object schemas)', async () => {
    const f = mockFetch([streamResponse([part([{ text: 'ok' }], 'STOP')])]);
    await new GoogleProvider(ctx(f)).complete({
      model: 'g',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          name: 'take_screenshot',
          description: 'shot',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      toolChoice: 'required',
    });
    const body = f.requests[0]!.body as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
      toolConfig: unknown;
    };
    expect(body.tools[0]!.functionDeclarations[0]).not.toHaveProperty('parameters');
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });

  it('lists only generateContent chat models and reads token limits from the provider', async () => {
    const f = mockFetch([
      json({
        models: [
          {
            name: 'models/gemini-pro-x',
            displayName: 'Gemini Pro X',
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    ]);
    const models = await new GoogleProvider(ctx(f)).listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      modelId: 'gemini-pro-x',
      tier: 'frontier',
      capabilitySource: 'provider',
      capabilities: { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    });
  });
});

describe('collectStream', () => {
  it('rejects a stream with no finish event', async () => {
    async function* truncated(): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', text: 'half' };
    }
    await expect(collectStream('m', truncated())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});

// keep the type import used
export type { AIRequest };
