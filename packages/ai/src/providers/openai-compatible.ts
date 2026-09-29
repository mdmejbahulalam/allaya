import { AllayaError, redactString } from '@allaya/shared';
import { BaseProvider } from '../base-provider';
import { send } from '../http';
import { ToolCallAccumulator } from '../provider';
import { parseSse } from '../sse';
import type { AIMessage, AIRequest, FinishReason, StreamEvent, ToolChoice } from '../types';

// ── Wire types (only the fields we read/write) ──────────────────────────────
type OpenAIContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAIStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; code?: string | number; type?: string };
}

// ── Translation ─────────────────────────────────────────────────────────────
export function toOpenAIMessages(
  system: string | undefined,
  messages: AIMessage[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (message.content.trim()) out.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const text = message.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const calls = message.content.filter((p) => p.type === 'tool_call');
      if (!text && calls.length === 0) continue;
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : {}),
      });
      continue;
    }

    // user: tool results become separate `tool` messages that must directly follow the assistant tool_calls.
    for (const part of message.content) {
      if (part.type === 'tool_result')
        out.push({ role: 'tool', tool_call_id: part.toolCallId, content: part.content });
    }
    const parts: OpenAIContentPart[] = [];
    for (const part of message.content) {
      if (part.type === 'text' && part.text.trim()) parts.push({ type: 'text', text: part.text });
      else if (part.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
        });
      }
    }
    if (parts.length === 1 && parts[0]!.type === 'text')
      out.push({ role: 'user', content: parts[0]!.text });
    else if (parts.length > 0) out.push({ role: 'user', content: parts });
  }
  return out;
}

function toToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  return { type: 'function', function: { name: choice.name } };
}

const FINISH: Record<string, FinishReason> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  content_filter: 'content_filter',
};

export interface OpenAICompatibleConfig {
  /** `max_completion_tokens` (OpenAI proper) or `max_tokens` (most compatible servers). */
  maxTokensParam: 'max_completion_tokens' | 'max_tokens';
  extraHeaders?: Record<string, string>;
  /** Reasoning models reject a custom temperature. */
  omitTemperature?: (model: string) => boolean;
}

export abstract class OpenAICompatibleProvider extends BaseProvider {
  protected abstract readonly config: OpenAICompatibleConfig;

  protected async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.context.getApiKey()}`,
      'content-type': 'application/json',
      ...(this.config.extraHeaders ?? {}),
    };
  }

  protected buildBody(request: AIRequest): Record<string, unknown> {
    const toolChoice = toToolChoice(request.toolChoice);
    const omitTemperature = this.config.omitTemperature?.(request.model) ?? false;
    return {
      model: request.model,
      messages: toOpenAIMessages(request.system, request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxTokens !== undefined
        ? { [this.config.maxTokensParam]: request.maxTokens }
        : {}),
      ...(request.temperature !== undefined && !omitTemperature
        ? { temperature: request.temperature }
        : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(toolChoice !== undefined && request.tools?.length ? { tool_choice: toolChoice } : {}),
    };
  }

  async *stream(request: AIRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const { response, dispose } = await send(this.http(), {
      url: `${this.baseUrl}/chat/completions`,
      headers: await this.headers(),
      body: this.buildBody(request),
      signal,
    });

    try {
      if (!response.body)
        throw new AllayaError(`${this.id}: empty response body`, { code: 'PROVIDER_ERROR' });
      const tools = new ToolCallAccumulator();
      let finishReason: FinishReason | undefined;
      let sawToolCall = false;
      let started = false;
      let done = false;

      for await (const message of parseSse(response.body)) {
        if (message.data === '[DONE]') {
          done = true;
          break;
        }
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(message.data) as OpenAIStreamChunk;
        } catch {
          continue;
        }

        if (chunk.error) {
          throw new AllayaError(
            `${this.id}: ${redactString(chunk.error.message ?? 'stream error')}`,
            {
              code: 'PROVIDER_ERROR',
              details: { provider: this.id, type: chunk.error.type },
            },
          );
        }
        if (!started) {
          started = true;
          yield { type: 'start', model: chunk.model ?? request.model };
        }

        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) yield { type: 'text_delta', text: choice.delta.content };

        for (const fragment of choice?.delta?.tool_calls ?? []) {
          // id and name arrive on the first fragment of a call; later fragments carry argument text only.
          if (!tools.has(fragment.index) && fragment.id && fragment.function?.name) {
            tools.begin(fragment.index, fragment.id, fragment.function.name);
          }
          if (fragment.function?.arguments)
            tools.append(fragment.index, fragment.function.arguments);
        }

        if (choice?.finish_reason) {
          for (const call of tools.finishAll()) {
            sawToolCall = true;
            yield { type: 'tool_call', call };
          }
          finishReason = FINISH[choice.finish_reason] ?? 'error';
        }

        // With include_usage, usage arrives in a trailing chunk *after* finish_reason.
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              ...(chunk.usage.prompt_tokens !== undefined
                ? { inputTokens: chunk.usage.prompt_tokens }
                : {}),
              ...(chunk.usage.completion_tokens !== undefined
                ? { outputTokens: chunk.usage.completion_tokens }
                : {}),
            },
          };
        }
      }

      // Calls still open when the stream ends without a finish_reason chunk.
      for (const call of tools.finishAll()) {
        sawToolCall = true;
        yield { type: 'tool_call', call };
      }
      if (finishReason !== undefined || done) {
        const reason: FinishReason =
          sawToolCall && (finishReason === undefined || finishReason === 'stop')
            ? 'tool_calls'
            : (finishReason ?? 'stop');
        yield { type: 'finish', reason };
      }
    } finally {
      dispose();
    }
  }
}
