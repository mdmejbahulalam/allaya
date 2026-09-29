/**
 * Script-level text utilities. Bengali needs care that Latin text does not:
 *  - the same visible text can be encoded several ways (e.g. য় as U+09DF or U+09AF+U+09BC), so everything
 *    that is compared is NFC-normalised first;
 *  - ZWJ/ZWNJ (U+200D/U+200C) appear inside conjuncts and some spellings but must not affect matching;
 *  - punctuation differs (the danda ।), and digits may be Bengali (০-৯).
 */

const BENGALI_BLOCK = /[\u0980-\u09FF]/;
const BENGALI_LETTER =
  // eslint-disable-next-line no-misleading-character-class -- explicit code point ranges; the Bengali vowel signs (matras) are intended members of the class
  /[\u0985-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC-\u09E3\u09F0\u09F1\u0981-\u0983]/;
const LATIN_LETTER = /[A-Za-z]/;

export function isBengaliChar(char: string): boolean {
  return BENGALI_BLOCK.test(char);
}

export function hasBengali(text: string): boolean {
  return BENGALI_BLOCK.test(text);
}

/** Canonical form for matching: NFC, no zero-width joiners, single spaces. */
export function canonicalize(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';

/** ১২৩ → 123. Leaves everything else alone. */
export function normalizeDigits(text: string): string {
  let out = '';
  for (const char of text) {
    const index = BENGALI_DIGITS.indexOf(char);
    out += index >= 0 ? String(index) : char;
  }
  return out;
}

/** Bengali sentence punctuation → ASCII, so downstream rules see one form. */
export function normalizePunctuation(text: string): string {
  return text
    .replace(/[।॥]/g, '.')
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...');
}

export interface ScriptCounts {
  bengali: number;
  latin: number;
  digits: number;
  other: number;
}

export function countScripts(text: string): ScriptCounts {
  const counts: ScriptCounts = { bengali: 0, latin: 0, digits: 0, other: 0 };
  for (const char of normalizeDigits(text)) {
    if (BENGALI_LETTER.test(char)) counts.bengali += 1;
    else if (LATIN_LETTER.test(char)) counts.latin += 1;
    else if (/[0-9]/.test(char)) counts.digits += 1;
    else if (/\p{L}/u.test(char)) counts.other += 1;
  }
  return counts;
}

export interface WordToken {
  text: string;
  start: number;
  end: number;
}

/** Splits into word-ish tokens, keeping offsets. Hyphens and apostrophes inside words are kept. */
export function tokenize(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const pattern = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’_.\-+#/\\:]*/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0].replace(/[.\-:/\\]+$/g, '');
    if (!raw) continue;
    const start = match.index ?? 0;
    tokens.push({ text: raw, start, end: start + raw.length });
  }
  return tokens;
}

export function isBengaliToken(token: string): boolean {
  return hasBengali(token);
}
