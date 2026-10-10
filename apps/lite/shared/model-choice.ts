import type { ModelRef, ModelView } from './ipc';

/**
 * What a task needs from its model. The person picks one in words; Allaya picks the model that fits from the ones
 * they have connected. (They can always choose a specific model instead.)
 */
export const MODEL_NEEDS = ['fast', 'balanced', 'smart', 'vision', 'long'] as const;
export type ModelNeed = (typeof MODEL_NEEDS)[number];

const first = (models: readonly ModelView[], test: (m: ModelView) => boolean) => models.find(test);

/**
 * The best match among the models on offer, in the order they are listed (the order services were connected). Tiers and
 * abilities may be guesses from a model's name, which the model list says; this only ever picks from what exists.
 */
export function suggestModel(models: readonly ModelView[], need: ModelNeed): ModelRef | undefined {
  const known = models.filter((m) => !m.inferred);
  const pool = (test: (m: ModelView) => boolean) => first(known, test) ?? first(models, test);
  let pick: ModelView | undefined;
  switch (need) {
    case 'fast':
      pick = pool((m) => m.tier === 'fast') ?? pool((m) => m.tier === 'balanced');
      break;
    case 'balanced':
      pick =
        pool((m) => m.tier === 'balanced') ?? pool((m) => m.tier === 'fast') ?? pool(() => true);
      break;
    case 'smart':
      pick =
        pool((m) => m.tier === 'frontier' && m.reasoning) ??
        pool((m) => m.tier === 'frontier') ??
        pool((m) => m.reasoning) ??
        pool((m) => m.tier === 'balanced');
      break;
    case 'vision':
      pick = pool((m) => m.vision && m.tier !== 'frontier') ?? pool((m) => m.vision);
      break;
    case 'long': {
      const biggest = [...models].sort((a, b) => b.contextWindow - a.contextWindow)[0];
      pick = biggest;
      break;
    }
  }
  pick ??= models[0];
  return pick ? { connectionId: pick.connectionId, modelId: pick.modelId } : undefined;
}
