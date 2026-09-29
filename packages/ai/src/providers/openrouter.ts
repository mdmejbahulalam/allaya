import { inferTier } from '../catalog';
import { postJson } from '../http';
import type { ModelInfo, ModelTier } from '../types';
import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible';

interface OpenRouterModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null };
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

/** Per-token USD strings → USD per million tokens. Returns undefined for missing/non-numeric prices. */
function perMillion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
}

function tierFromCost(modelId: string, inputPerMTok: number | undefined): ModelTier {
  if (inputPerMTok === undefined) return inferTier(modelId);
  if (inputPerMTok <= 0.6) return 'fast';
  if (inputPerMTok >= 8) return 'frontier';
  return 'balanced';
}

/** OpenRouter speaks the OpenAI wire format but publishes rich model metadata, which we use verbatim. */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly id = 'openrouter' as const;
  readonly name = 'OpenRouter';
  protected readonly defaultBaseUrl = 'https://openrouter.ai/api/v1';
  protected readonly config: OpenAICompatibleConfig = {
    maxTokensParam: 'max_tokens',
    extraHeaders: { 'x-title': 'Allaya' },
  };

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await postJson<{ data?: OpenRouterModelEntry[] }>(this.http(), {
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: await this.headers(),
      signal,
    });
    return (body.data ?? [])
      .filter((entry) => (entry.architecture?.output_modalities ?? ['text']).includes('text'))
      .map((entry): ModelInfo => {
        const input = perMillion(entry.pricing?.prompt);
        const output = perMillion(entry.pricing?.completion);
        return {
          providerId: 'openrouter',
          modelId: entry.id,
          displayName: entry.name ?? entry.id,
          tier: tierFromCost(entry.id, input),
          capabilitySource: 'provider',
          capabilities: {
            vision: (entry.architecture?.input_modalities ?? []).includes('image'),
            tools: entry.supported_parameters?.includes('tools') ?? false,
            streaming: true,
            reasoning:
              entry.supported_parameters?.includes('reasoning') ??
              /(reason|thinking|r1|o1|o3)/i.test(entry.id),
            contextWindow: entry.context_length ?? 8_000,
            ...(typeof entry.top_provider?.max_completion_tokens === 'number'
              ? { maxOutputTokens: entry.top_provider.max_completion_tokens }
              : {}),
          },
          ...(input !== undefined && output !== undefined
            ? { cost: { inputPerMTok: input, outputPerMTok: output } }
            : {}),
        };
      });
  }
}
