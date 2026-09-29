/**
 * Conservative token estimate without a tokenizer. Errs high so context windows are never overrun.
 * Latin text averages ~4 chars/token; Bengali and other Indic scripts tokenize far less efficiently
 * (often ~1 token per 1–2 characters), so non-ASCII code points are weighted much more heavily.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3.5 + other / 1.2);
}
