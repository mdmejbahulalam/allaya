import type { MemoryCategory } from '@allaya/types';
import type { MemoryRecord } from './store';
import { tokens, wordsMatch } from './text';

/**
 * Standing preferences the person set: they shape every reply, so they are always considered. (They still count
 * against the same size limit as everything else.)
 */
export const ALWAYS_CONSIDERED: ReadonlySet<MemoryCategory> = new Set(['instructions', 'language']);

const KEY_WEIGHT = 3;
const VALUE_WEIGHT = 1;
const CATEGORY_WEIGHT = 1;
const ALWAYS_SCORE = 100;

export interface Ranked {
  memory: MemoryRecord;
  score: number;
}

const overlap = (queryWords: readonly string[], words: readonly string[]): number => {
  let hits = 0;
  for (const word of new Set(words)) {
    if (queryWords.some((q) => wordsMatch(q, word))) hits += 1;
  }
  return hits;
};

/**
 * Memories that bear on `query`, best first. Plain word matching (with light Bengali and English stemming): there are
 * no embeddings, so a memory is found only when it shares a word with the request. That is deliberate — it is
 * predictable, needs no model call, and never sends anything anywhere.
 */
export function rank(memories: readonly MemoryRecord[], query: string): Ranked[] {
  const queryWords = tokens(query);
  const out: Ranked[] = [];
  for (const memory of memories) {
    let score = 0;
    if (queryWords.length > 0) {
      score += KEY_WEIGHT * overlap(queryWords, tokens(memory.key));
      score += VALUE_WEIGHT * overlap(queryWords, tokens(memory.value));
      score += CATEGORY_WEIGHT * overlap(queryWords, tokens(memory.category));
    }
    if (ALWAYS_CONSIDERED.has(memory.category)) score += ALWAYS_SCORE;
    if (score > 0) out.push({ memory, score });
  }
  return out.sort(
    (a, b) =>
      b.score - a.score ||
      b.memory.updatedAt - a.memory.updatedAt ||
      a.memory.id.localeCompare(b.memory.id),
  );
}
