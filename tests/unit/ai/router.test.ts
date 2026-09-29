import { describe, expect, it } from 'vitest';
import {
  ModelRouter,
  desiredTier,
  inferredModel,
  type ModelInfo,
  type RoutingConfig,
} from '@allaya/ai';

const model = (
  providerId: ModelInfo['providerId'],
  modelId: string,
  over: Partial<ModelInfo['capabilities']> = {},
  tier?: ModelInfo['tier'],
): ModelInfo => {
  const base = inferredModel(providerId, modelId);
  return { ...base, ...(tier ? { tier } : {}), capabilities: { ...base.capabilities, ...over } };
};

const opus = model('anthropic', 'claude-opus-5-5');
const sonnet = model('anthropic', 'claude-sonnet-5-5');
const haiku = model('anthropic', 'claude-haiku-4-5-20251001');
const gpt = model('openai', 'gpt-4o');
const noVision = model(
  'openrouter',
  'vendor/text-only',
  { vision: false, tools: true, contextWindow: 32_000 },
  'balanced',
);
const noTools = model('openrouter', 'vendor/no-tools', { tools: false }, 'balanced');

const router = (models: ModelInfo[], config: Partial<RoutingConfig> = {}) =>
  new ModelRouter(
    () => models,
    () => ({ autoRouting: true, assignments: {}, ...config }),
  );

describe('desired tier', () => {
  it.each([
    [{ purpose: 'reasoning' }, 'frontier'],
    [{ purpose: 'agent_planning' }, 'frontier'],
    [{ purpose: 'fast' }, 'fast'],
    [{ complexity: 'trivial' }, 'fast'],
    [{ complexity: 'simple', purpose: 'coding' }, 'balanced'],
    [{ complexity: 'multi_step' }, 'balanced'],
    [{ complexity: 'complex' }, 'frontier'],
    [{}, 'balanced'],
  ] as const)('%j → %s', (req, tier) => expect(desiredTier(req)).toBe(tier));
});

describe('ModelRouter', () => {
  it('refuses cleanly when nothing is configured (no-API-key mode)', () => {
    expect(() => router([]).select()).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
  });

  it('auto-routing matches the model tier to task complexity', () => {
    const r = router([opus, sonnet, haiku]);
    expect(r.select({ complexity: 'trivial' }).model.modelId).toBe(haiku.modelId);
    expect(r.select({ complexity: 'multi_step' }).model.modelId).toBe(sonnet.modelId);
    expect(r.select({ complexity: 'complex' }).model.modelId).toBe(opus.modelId);
    expect(r.select({ complexity: 'complex' }).source).toBe('auto');
  });

  it('hard requirements are never violated: vision and tools filter candidates', () => {
    const r = router([noVision, sonnet]);
    expect(r.select({ needsVision: true }).model.modelId).toBe(sonnet.modelId);
    expect(router([noTools, sonnet]).select({ needsTools: true }).model.modelId).toBe(
      sonnet.modelId,
    );
    expect(() => router([noVision]).select({ needsVision: true })).toThrowError(/vision/);
  });

  it('context length is a hard constraint including output headroom', () => {
    const r = router([noVision, sonnet]); // 32k vs 200k
    expect(r.select({ estimatedInputTokens: 100_000 }).model.modelId).toBe(sonnet.modelId);
    expect(() => router([noVision]).select({ estimatedInputTokens: 31_000 })).toThrow();
  });

  it('an explicit pin wins when eligible, and falls back when it cannot satisfy the request', () => {
    const r = router([opus, haiku, noVision]);
    expect(
      r.select({
        complexity: 'trivial',
        pinned: { providerId: 'anthropic', modelId: opus.modelId },
      }),
    ).toMatchObject({ source: 'pinned', model: { modelId: opus.modelId } });
    const decision = r.select({
      needsVision: true,
      pinned: { providerId: 'openrouter', modelId: noVision.modelId },
    });
    expect(decision.source).not.toBe('pinned');
    expect(decision.model.capabilities.vision).toBe(true);
  });

  it('with auto-routing OFF the per-purpose assignment rules, then the general assignment', () => {
    const config: Partial<RoutingConfig> = {
      autoRouting: false,
      assignments: {
        coding: { providerId: 'openai', modelId: gpt.modelId },
        general: { providerId: 'anthropic', modelId: sonnet.modelId },
      },
    };
    const r = router([opus, sonnet, haiku, gpt], config);
    expect(r.select({ purpose: 'coding', complexity: 'complex' })).toMatchObject({
      source: 'user_assignment',
      model: { modelId: gpt.modelId },
    });
    expect(r.select({ purpose: 'vision' }).model.modelId).toBe(sonnet.modelId); // falls back to general
    expect(r.select({ purpose: 'reasoning' }).model.modelId).toBe(sonnet.modelId);
  });

  it('with auto-routing ON an assignment is a preference, not an override', () => {
    const config: Partial<RoutingConfig> = {
      autoRouting: true,
      assignments: { coding: { providerId: 'anthropic', modelId: sonnet.modelId } },
    };
    const r = router([opus, sonnet, haiku], config);
    // balanced fit + preference bonus → the assigned model
    expect(r.select({ purpose: 'coding', complexity: 'multi_step' }).model.modelId).toBe(
      sonnet.modelId,
    );
    // but a complex task still escalates past the preference
    expect(r.select({ purpose: 'coding', complexity: 'complex' }).model.modelId).toBe(opus.modelId);
  });

  it('an assignment that is unavailable or ineligible is ignored, not an error', () => {
    const config: Partial<RoutingConfig> = {
      autoRouting: false,
      assignments: { vision: { providerId: 'openrouter', modelId: noVision.modelId } },
    };
    expect(
      router([noVision, sonnet], config).select({ purpose: 'vision', needsVision: true }).model
        .modelId,
    ).toBe(sonnet.modelId);
    const ghost: Partial<RoutingConfig> = {
      autoRouting: false,
      assignments: { general: { providerId: 'google', modelId: 'gone' } },
    };
    expect(router([sonnet], ghost).select().model.modelId).toBe(sonnet.modelId);
  });

  it('is deterministic: identical candidates always resolve the same way, regardless of input order', () => {
    const a = model('openai', 'model-a');
    const b = model('anthropic', 'model-b');
    const first = router([a, b]).select().model;
    const second = router([b, a]).select().model;
    expect(second).toEqual(first);
  });

  it('low-latency and low-cost preferences bias toward cheaper/faster models within the same tier fit', () => {
    const cheap = {
      ...model('openrouter', 'v/cheap', {}, 'balanced'),
      cost: { inputPerMTok: 0.5, outputPerMTok: 1 },
    };
    const dear = {
      ...model('openrouter', 'v/dear', {}, 'balanced'),
      cost: { inputPerMTok: 15, outputPerMTok: 60 },
    };
    expect(router([dear, cheap]).select({ preferLowCost: true }).model.modelId).toBe('v/cheap');
  });

  it('explains its choice for the UI', () => {
    const d = router([opus, haiku]).select({ needsVision: true, complexity: 'complex' });
    expect(d.reason).toMatch(/vision required/);
    expect(d.reason).toMatch(/frontier/);
  });
});
