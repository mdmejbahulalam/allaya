import type { ProviderId } from '@allaya/types';
import type { ModelCapabilities, ModelInfo, ModelTier } from './types';

/**
 * Capability inference from model names. Providers rarely publish vision/tool/tier metadata on their
 * model-list endpoints, so this is a *fallback*: results are always flagged
 * `capabilitySource: 'inferred'` so the UI/router never present a guess as fact, and every value here is
 * deliberately conservative (context windows are lower bounds).
 */

const NON_CHAT =
  /(embed|embedding|whisper|tts|transcribe|speech|dall-e|image|imagen|moderation|realtime|audio|rerank|guard|aqa|veo|lyria|computer-use|search-preview)/i;

export function isChatModel(providerId: ProviderId, modelId: string): boolean {
  if (NON_CHAT.test(modelId)) return false;
  switch (providerId) {
    case 'anthropic':
      return /^claude/i.test(modelId);
    case 'openai':
      return /^(gpt|o\d|chatgpt)/i.test(modelId);
    case 'google':
      return /^gemini/i.test(modelId) || /^gemma/i.test(modelId);
    case 'openrouter':
      return true;
  }
}

export function inferTier(modelId: string): ModelTier {
  const id = modelId.toLowerCase();
  if (/(haiku|mini|nano|flash|lite|small|instant|8b|7b|3b|1b)/.test(id)) return 'fast';
  if (/(opus|fable|ultra|\bpro\b|-pro|max|frontier|o1|o3|o4|gpt-5(?!.*(mini|nano)))/.test(id))
    return 'frontier';
  return 'balanced';
}

function inferVision(providerId: ProviderId, modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (providerId === 'anthropic') return /^claude/.test(id);
  if (providerId === 'google') return /^gemini/.test(id);
  if (providerId === 'openai')
    return /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1|o3|o4|vision)/.test(id);
  return /(vision|vl|4o|claude|gemini|gpt-4|gpt-5|llava|pixtral)/.test(id);
}

const CONSERVATIVE_CONTEXT: Record<ProviderId, number> = {
  anthropic: 200_000,
  openai: 128_000,
  google: 128_000,
  openrouter: 32_000,
};

export function inferCapabilities(providerId: ProviderId, modelId: string): ModelCapabilities {
  return {
    vision: inferVision(providerId, modelId),
    tools: true,
    streaming: true,
    reasoning: /(opus|fable|o1|o3|o4|gpt-5|thinking|reason|r1|pro\b)/i.test(modelId),
    contextWindow: CONSERVATIVE_CONTEXT[providerId],
  };
}

/** Builds a `ModelInfo` from a bare model id, with inferred metadata. */
export function inferredModel(
  providerId: ProviderId,
  modelId: string,
  displayName = modelId,
): ModelInfo {
  return {
    providerId,
    modelId,
    displayName,
    capabilities: inferCapabilities(providerId, modelId),
    tier: inferTier(modelId),
    capabilitySource: 'inferred',
  };
}

/**
 * Models Anthropic documents publicly, used as a last-resort seed if discovery fails while a key is
 * configured. Discovery (`GET /v1/models`) always wins over this list.
 */
export const ANTHROPIC_FALLBACK_MODELS: readonly ModelInfo[] = [
  inferredModel('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1'),
  inferredModel('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5'),
  inferredModel('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5'),
  inferredModel('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5'),
];
