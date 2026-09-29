import { AllayaError } from '@allaya/shared';
import type { ProviderId } from '@allaya/types';
import type { FetchLike } from './http';
import type {
  AIRequest,
  AIResponse,
  ConnectionTestResult,
  FinishReason,
  ModelInfo,
  StreamEvent,
  ToolCall,
  Usage,
} from './types';

/** Everything a provider needs from the trusted host. The key is fetched per call and never retained. */
export interface ProviderContext {
  /** Returns the decrypted API key, or throws PROVIDER_NOT_CONFIGURED. */
  getApiKey(): Promise<string>;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly name: string;
  /** Discovers available chat models. Also used as the cheap, token-free connectivity probe. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
  stream(request: AIRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
  complete(request: AIRequest, signal?: AbortSignal): Promise<AIResponse>;
}

/** Folds a stream into a single response. A stream that ends without a finish event is an error. */
export async function collectStream(
  model: string,
  events: AsyncIterable<StreamEvent>,
): Promise<AIResponse> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason: FinishReason | undefined;
  let resolvedModel = model;

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        resolvedModel = event.model;
        break;
      case 'text_delta':
        text += event.text;
        break;
      case 'tool_call':
        toolCalls.push(event.call);
        break;
      case 'usage':
        if (event.usage.inputTokens !== undefined) usage.inputTokens = event.usage.inputTokens;
        if (event.usage.outputTokens !== undefined) usage.outputTokens = event.usage.outputTokens;
        break;
      case 'finish':
        finishReason = event.reason;
        break;
    }
  }

  if (finishReason === undefined) {
    throw new AllayaError('The AI provider ended its response unexpectedly', {
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  }
  return { model: resolvedModel, text, toolCalls, finishReason, usage };
}

/**
 * Providers stream tool arguments as JSON fragments. This gathers them per call slot and parses once
 * complete. Malformed JSON is surfaced as a typed error so the orchestrator can ask the model to retry —
 * it is never guessed at or "repaired".
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<number, { id: string; name: string; json: string }>();

  begin(index: number, id: string, name: string): void {
    this.slots.set(index, { id, name, json: '' });
  }

  append(index: number, fragment: string): void {
    const slot = this.slots.get(index);
    if (slot) slot.json += fragment;
  }

  /** True when a slot exists (used by OpenAI, where id/name arrive on the first delta only). */
  has(index: number): boolean {
    return this.slots.has(index);
  }

  finish(index: number): ToolCall | undefined {
    const slot = this.slots.get(index);
    if (!slot) return undefined;
    this.slots.delete(index);
    return { id: slot.id, name: slot.name, arguments: parseToolArguments(slot.name, slot.json) };
  }

  /** Completes every open slot in index order. */
  finishAll(): ToolCall[] {
    return [...this.slots.keys()]
      .sort((a, b) => a - b)
      .map((index) => this.finish(index))
      .filter((call): call is ToolCall => call !== undefined);
  }
}

export function parseToolArguments(toolName: string, json: string): Record<string, unknown> {
  const trimmed = json.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new AllayaError(`The model produced malformed arguments for tool "${toolName}"`, {
      code: 'PROVIDER_ERROR',
      retryable: true,
      details: { tool: toolName },
      cause,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AllayaError(`The model produced non-object arguments for tool "${toolName}"`, {
      code: 'PROVIDER_ERROR',
      retryable: true,
      details: { tool: toolName },
    });
  }
  return parsed as Record<string, unknown>;
}
