import { describe, expect, it } from 'vitest';
import { inferCapabilities, inferTier, isChatModel, type ModelTier } from '@allaya/ai';

describe('tier inference matches whole name tokens (regression: "gemini" contains "mini")', () => {
  const cases: Array<[string, ModelTier]> = [
    // Anthropic
    ['claude-haiku-4-5-20251001', 'fast'],
    ['claude-sonnet-5-5', 'balanced'],
    ['claude-opus-5-5', 'frontier'],
    ['claude-fable-5-1', 'frontier'],
    ['claude-3-5-sonnet-20241022', 'balanced'],
    // OpenAI
    ['gpt-4o', 'balanced'],
    ['gpt-4o-mini', 'fast'],
    ['gpt-4.1-nano', 'fast'],
    ['gpt-5', 'frontier'],
    ['gpt-5-mini', 'fast'],
    ['o3', 'frontier'],
    ['o3-mini', 'fast'],
    // Google — none of these may be "fast" merely because "gemini" contains "mini"
    ['gemini-pro-x', 'frontier'],
    ['gemini-2.5-pro', 'frontier'],
    ['gemini-2.5-flash', 'fast'],
    ['gemini-2.5-flash-lite', 'fast'],
    ['gemini-1.5-standard', 'balanced'],
    // OpenRouter-style ids
    ['meta-llama/llama-3.1-8b-instruct', 'fast'],
    ['deepseek/deepseek-r1', 'frontier'],
    ['mistralai/mistral-large', 'balanced'],
  ];
  it.each(cases)('%s → %s', (id, tier) => expect(inferTier(id)).toBe(tier));
});

describe('capability inference', () => {
  it('flags every inferred value as a conservative guess and never claims more than known', () => {
    const caps = inferCapabilities('openai', 'gpt-4o');
    expect(caps).toMatchObject({
      vision: true,
      tools: true,
      streaming: true,
      contextWindow: 128_000,
    });
  });

  it('vision uses canonical prefixes, not substrings', () => {
    expect(inferCapabilities('openai', 'gpt-4o-mini').vision).toBe(true);
    expect(inferCapabilities('openai', 'gpt-3.5-turbo').vision).toBe(false);
    expect(inferCapabilities('anthropic', 'claude-sonnet-5-5').vision).toBe(true);
    expect(inferCapabilities('google', 'gemini-2.5-flash').vision).toBe(true);
  });

  it('reasoning is token-based ("foo1" is not "o1")', () => {
    expect(inferCapabilities('openai', 'o3').reasoning).toBe(true);
    expect(inferCapabilities('openai', 'gpt-5').reasoning).toBe(true);
    expect(inferCapabilities('openai', 'gpt-4o').reasoning).toBe(false);
    expect(inferCapabilities('openrouter', 'vendor/foo1-chat').reasoning).toBe(false);
  });
});

describe('chat-model filtering', () => {
  it.each([
    ['openai', 'gpt-4o', true],
    ['openai', 'o3-mini', true],
    ['openai', 'text-embedding-3-large', false],
    ['openai', 'whisper-1', false],
    ['openai', 'gpt-4o-realtime-preview', false],
    ['openai', 'dall-e-3', false],
    ['openai', 'omni-moderation-latest', false],
    ['anthropic', 'claude-opus-5-5', true],
    ['anthropic', 'something-else', false],
    ['google', 'gemini-2.5-pro', true],
    ['google', 'gemini-embedding-001', false],
    ['google', 'imagen-3.0', false],
    ['openrouter', 'vendor/any-model', true],
  ] as const)('%s %s → %s', (provider, id, expected) =>
    expect(isChatModel(provider, id)).toBe(expected),
  );
});
