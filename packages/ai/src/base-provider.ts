import { toSerializedError } from '@allaya/shared';
import type { ProviderId } from '@allaya/types';
import type { FetchLike, HttpOptions } from './http';
import { collectStream, type AIProvider, type ProviderContext } from './provider';
import type { AIRequest, AIResponse, ConnectionTestResult, ModelInfo, StreamEvent } from './types';

/**
 * Shared behaviour: one wire path to get right per provider (`stream`), with `complete` built on it, and
 * the connectivity probe built on model discovery (free — it consumes no tokens).
 */
export abstract class BaseProvider implements AIProvider {
  abstract readonly id: ProviderId;
  abstract readonly name: string;

  constructor(protected readonly context: ProviderContext) {}

  abstract listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  abstract stream(request: AIRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;

  complete(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    return collectStream(request.model, this.stream(request, signal));
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const started = performance.now();
    try {
      const models = await this.listModels(signal);
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - started),
        modelCount: models.length,
      };
    } catch (error) {
      const serialized = toSerializedError(error);
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        errorCode: serialized.code,
        errorMessage: serialized.message,
      };
    }
  }

  protected get baseUrl(): string {
    return (this.context.baseUrl ?? this.defaultBaseUrl).replace(/\/+$/, '');
  }

  protected abstract readonly defaultBaseUrl: string;

  protected http(): HttpOptions {
    const doFetch: FetchLike =
      this.context.fetch ?? ((input, init) => globalThis.fetch(input, init));
    return {
      provider: this.id,
      fetch: doFetch,
      ...(this.context.timeoutMs !== undefined ? { timeoutMs: this.context.timeoutMs } : {}),
      ...(this.context.maxRetries !== undefined ? { maxRetries: this.context.maxRetries } : {}),
      ...(this.context.backoffMs !== undefined ? { backoffMs: this.context.backoffMs } : {}),
    };
  }
}
