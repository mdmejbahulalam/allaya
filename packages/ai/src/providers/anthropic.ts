import { AllayaError, redactString, type ErrorCode } from '@allaya/shared';
import { BaseProvider } from '../base-provider';
import { inferCapabilities, inferTier, isChatModel } from '../catalog';
import { send, postJson } from '../http';
import { ToolCallAccumulator } from '../provider';
import { parseSse } from '../sse';
import type {
  AIMessage,
  AIRequest,
  ContentPart,
  FinishReason,
  ModelInfo,
  StreamEvent,
  ToolChoice,
} from '../types';

const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

// ── Wire types (only the fields we read) ────────────────────────────────────
type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

interface AnthropicModelEntry {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: {
    image_input?: { supported?: boolean };
    thinking?: { supported?: boolean };
  };
}

// ── Translation ─────────────────────────────────────────────────────────────
function toBlocks(content: string | ContentPart[]): AnthropicBlock[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        // The API rejects empty text blocks.
        if (part.text.trim()) blocks.push({ type: 'text', text: part.text });
        break;
      case 'image':
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 },
        });
        break;
      case 'tool_call':
        blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.arguments });
        break;
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        });
        break;
    }
  }
  // tool_result blocks must precede any other content in the user turn.
  return [
    ...blocks.filter((b) => b.type === 'tool_result'),
    ...blocks.filter((b) => b.type !== 'tool_result'),
  ];
}

export function toAnthropicMessages(messages: AIMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    const content = toBlocks(message.content);
    if (content.length === 0) continue;
    const previous = out[out.length - 1];
    // Consecutive same-role turns are merged: the API requires alternating roles.
    if (previous && previous.role === message.role) {
      previous.content = [
        ...previous.content.filter((b) => b.type === 'tool_result'),
        ...content.filter((b) => b.type === 'tool_result'),
        ...previous.content.filter((b) => b.type !== 'tool_result'),
        ...content.filter((b) => b.type !== 'tool_result'),
      ];
    } else out.push({ role: message.role, content });
  }
  return out;
}

function toToolChoice(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
  if (choice === undefined || choice === 'auto') return undefined; // the API default
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.name };
}

export function toAnthropicBody(request: AIRequest): Record<string, unknown> {
  const toolChoice = toToolChoice(request.toolChoice);
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(request.messages),
    ...(request.system ? { system: request.system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }
      : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

const ERROR_CODES: Record<string, { code: ErrorCode; retryable: boolean }> = {
  authentication_error: { code: 'PROVIDER_AUTH_FAILED', retryable: false },
  permission_error: { code: 'PROVIDER_AUTH_FAILED', retryable: false },
  rate_limit_error: { code: 'PROVIDER_RATE_LIMITED', retryable: true },
  overloaded_error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
  api_error: { code: 'PROVIDER_UNAVAILABLE', retryable: true },
};

export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic' as const;
  readonly name = 'Anthropic';
  protected readonly defaultBaseUrl = 'https://api.anthropic.com';

  private async headers(): Promise<Record<string, string>> {
    return {
      'x-api-key': await this.context.getApiKey(),
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await postJson<{ data?: AnthropicModelEntry[] }>(this.http(), {
      url: `${this.baseUrl}/v1/models?limit=1000`,
      method: 'GET',
      headers: await this.headers(),
      signal,
    });
    return (body.data ?? [])
      .filter((entry) => isChatModel('anthropic', entry.id))
      .map((entry): ModelInfo => {
        const inferred = inferCapabilities('anthropic', entry.id);
        const fromProvider = typeof entry.max_input_tokens === 'number';
        return {
          providerId: 'anthropic',
          modelId: entry.id,
          displayName: entry.display_name ?? entry.id,
          tier: inferTier(entry.id),
          capabilitySource: fromProvider ? 'provider' : 'inferred',
          capabilities: {
            ...inferred,
            vision: entry.capabilities?.image_input?.supported ?? inferred.vision,
            reasoning: entry.capabilities?.thinking?.supported ?? inferred.reasoning,
            contextWindow: entry.max_input_tokens ?? inferred.contextWindow,
            ...(typeof entry.max_tokens === 'number' ? { maxOutputTokens: entry.max_tokens } : {}),
          },
        };
      });
  }

  async *stream(request: AIRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const { response, dispose } = await send(this.http(), {
      url: `${this.baseUrl}/v1/messages`,
      headers: await this.headers(),
      body: { ...toAnthropicBody(request), stream: true },
      signal,
    });

    try {
      if (!response.body)
        throw new AllayaError('anthropic: empty response body', { code: 'PROVIDER_ERROR' });
      const tools = new ToolCallAccumulator();
      let stopReason: string | undefined;
      yield { type: 'start', model: request.model };

      for await (const message of parseSse(response.body)) {
        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(message.data) as AnthropicStreamEvent;
        } catch {
          continue; // keep-alive or non-JSON frame
        }
        const index = event.index ?? 0;

        switch (event.type) {
          case 'message_start':
            if (event.message?.model) yield { type: 'start', model: event.message.model };
            if (event.message?.usage) {
              yield {
                type: 'usage',
                usage: {
                  ...(event.message.usage.input_tokens !== undefined
                    ? { inputTokens: event.message.usage.input_tokens }
                    : {}),
                  ...(event.message.usage.output_tokens !== undefined
                    ? { outputTokens: event.message.usage.output_tokens }
                    : {}),
                },
              };
            }
            break;
          case 'content_block_start':
            if (
              event.content_block?.type === 'tool_use' &&
              event.content_block.id &&
              event.content_block.name
            ) {
              tools.begin(index, event.content_block.id, event.content_block.name);
            }
            break;
          case 'content_block_delta':
            if (event.delta?.type === 'text_delta' && event.delta.text)
              yield { type: 'text_delta', text: event.delta.text };
            else if (
              event.delta?.type === 'input_json_delta' &&
              event.delta.partial_json !== undefined
            ) {
              tools.append(index, event.delta.partial_json);
            }
            break;
          case 'content_block_stop': {
            const call = tools.finish(index);
            if (call) yield { type: 'tool_call', call };
            break;
          }
          case 'message_delta':
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            if (event.usage?.output_tokens !== undefined) {
              yield { type: 'usage', usage: { outputTokens: event.usage.output_tokens } };
            }
            break;
          case 'message_stop':
            yield { type: 'finish', reason: STOP_REASONS[stopReason ?? 'end_turn'] ?? 'stop' };
            return;
          case 'error': {
            const mapped = ERROR_CODES[event.error?.type ?? ''] ?? {
              code: 'PROVIDER_ERROR' as const,
              retryable: false,
            };
            throw new AllayaError(
              `anthropic: ${redactString(event.error?.message ?? 'stream error')}`,
              {
                code: mapped.code,
                retryable: mapped.retryable,
                details: { provider: 'anthropic', type: event.error?.type },
              },
            );
          }
          default:
            break; // ping, unknown future events
        }
      }
    } finally {
      dispose();
    }
  }
}
