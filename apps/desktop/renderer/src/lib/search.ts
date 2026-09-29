/**
 * Tiny fuzzy scorer for the command palette. Works for Bengali and Latin text:
 * inputs are NFC-normalised (Bengali vowel signs can arrive composed or decomposed) and
 * case-folded. Every whitespace-separated query token must match somewhere.
 */
export function normalizeForSearch(input: string): string {
  return input.normalize('NFC').toLocaleLowerCase().trim();
}

function tokenScore(token: string, haystack: string): number {
  if (!token) return 0;
  if (haystack.startsWith(token)) return 4;
  const words = haystack.split(/[\s\-_/·:]+/);
  if (words.some((word) => word.startsWith(token))) return 3;
  if (haystack.includes(token)) return 2;
  return 0;
}

/** 0 = no match; higher is better. `texts[0]` is the primary label (weighted higher). */
export function scoreMatch(query: string, texts: readonly string[]): number {
  const tokens = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  const haystacks = texts.map(normalizeForSearch);
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    haystacks.forEach((haystack, index) => {
      const score = tokenScore(token, haystack) * (index === 0 ? 1.5 : 1);
      if (score > best) best = score;
    });
    if (best === 0) return 0;
    total += best;
  }
  return total;
}
