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
    default:
      // Other vendors list only what they offer; the name filter above already removed speech, image and embedding
      // models, and the person can choose from what is left.
      return true;
  }
}

/**
 * Splits a model id into its alphanumeric tokens: `gemini-2.5-flash-lite` → {gemini, 2, 5, flash, lite}.
 * All name heuristics match whole tokens, never substrings — "gemini" contains "mini" and "gpt-4o-mini"
 * must not be confused with "gpt-4o".
 */
function tokens(modelId: string): Set<string> {
  return new Set(
    modelId
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

const FAST_TOKENS = [
  'haiku',
  'mini',
  'nano',
  'flash',
  'lite',
  'small',
  'instant',
  'tiny',
  '8b',
  '7b',
  '3b',
  '1b',
];
const FRONTIER_TOKENS = [
  'opus',
  'fable',
  'ultra',
  'pro',
  'max',
  'frontier',
  'o1',
  'o3',
  'o4',
  'r1',
];

export function inferTier(modelId: string): ModelTier {
  const t = tokens(modelId);
  // Small variants win: "o3-mini" and "gpt-5-mini" are fast even though "o3"/"gpt-5" are frontier.
  if (FAST_TOKENS.some((token) => t.has(token))) return 'fast';
  if (FRONTIER_TOKENS.some((token) => t.has(token)) || /^gpt-5/i.test(modelId)) return 'frontier';
  return 'balanced';
}

function inferVision(providerId: ProviderId, modelId: string): boolean {
  const id = modelId.toLowerCase();
  const t = tokens(id);
  if (providerId === 'anthropic') return id.startsWith('claude');
  if (providerId === 'google') return id.startsWith('gemini');
  if (providerId === 'openai') {
    return (
      ['gpt-4o', 'chatgpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5', 'o1', 'o3', 'o4'].some((prefix) =>
        id.startsWith(prefix),
      ) || t.has('vision')
    );
  }
  return ['vision', 'vl', '4o', 'claude', 'gemini', 'llava', 'pixtral'].some((token) =>
    t.has(token),
  );
}

const CONSERVATIVE_CONTEXT: Record<ProviderId, number> = {
  anthropic: 200_000,
  openai: 128_000,
  google: 128_000,
  openrouter: 32_000,
  groq: 32_000,
  mistral: 32_000,
  deepseek: 64_000,
  xai: 128_000,
  together: 32_000,
  // A model on this computer or at an address the person chose: the size is unknown, so assume a small one.
  ollama: 8_000,
  custom: 8_000,
};

function inferReasoning(modelId: string): boolean {
  const t = tokens(modelId);
  return (
    ['opus', 'fable', 'o1', 'o3', 'o4', 'thinking', 'reasoning', 'reasoner', 'r1', 'pro'].some(
      (token) => t.has(token),
    ) || /^gpt-5/i.test(modelId)
  );
}

export function inferCapabilities(providerId: ProviderId, modelId: string): ModelCapabilities {
  return {
    vision: inferVision(providerId, modelId),
    tools: true,
    streaming: true,
    reasoning: inferReasoning(modelId),
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
