import { inferCapabilities, inferTier, isChatModel } from '../catalog';
import { postJson } from '../http';
import type { ModelInfo } from '../types';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible';

interface OpenAIModelEntry {
  id: string;
  created?: number;
}

/** Reasoning-family models reject a custom temperature. */
const REASONING_MODEL = /^(o\d|gpt-5)/i;

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly id = 'openai' as const;
  readonly name = 'OpenAI';
  protected readonly defaultBaseUrl = 'https://api.openai.com/v1';
  protected readonly config: OpenAICompatibleConfig = {
    maxTokensParam: 'max_completion_tokens',
    omitTemperature: (model) => REASONING_MODEL.test(model),
  };

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await postJson<{ data?: OpenAIModelEntry[] }>(this.http(), {
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: await this.headers(),
      signal,
    });
    return (body.data ?? [])
      .filter((entry) => isChatModel('openai', entry.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((entry): ModelInfo => ({
        providerId: 'openai',
        modelId: entry.id,
        displayName: entry.id,
        capabilities: inferCapabilities('openai', entry.id),
        tier: inferTier(entry.id),
        capabilitySource: 'inferred',
      }));
  }
}
