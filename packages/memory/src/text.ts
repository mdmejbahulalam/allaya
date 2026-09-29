/** Text handling shared by search, the guard and the prompt block. Pure, Unicode-aware, Bengali-aware. */

/** Zero-width characters: written as escapes so no invisible character sits in the source. */
const INVISIBLE = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g');

/** Lower-cased, NFC, without zero-width characters — for comparing, never for storing or showing. */
export const fold = (text: string): string =>
  text.normalize('NFC').replace(INVISIBLE, '').toLowerCase();

const isControl = (codePoint: number) =>
  codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029;

/** One line of plain text: control characters and line breaks become one space, `<` and `>` are removed. */
export function oneLine(text: string, max: number): string {
  let out = '';
  for (const char of text) {
    if (isControl(char.codePointAt(0) ?? 0)) {
      if (!out.endsWith(' ')) out += ' ';
    } else if (char !== '<' && char !== '>') {
      out += char;
    }
  }
  return Array.from(out.replace(/ {2,}/g, ' ').trim()).slice(0, max).join('');
}

const STOPWORDS = new Set([
  ...'a an the is are was were to of and or in on for my me i you it its that this with be at as by do does not'.split(
    ' ',
  ),
  ...'এবং ও আর এই সেই যে কি কী না আমি আমার তুমি তোমার আপনি আপনার হয় হল করে জন্য থেকে'.split(' '),
]);

/** Common Bengali case endings and plural markers, longest first, so "ব্রাউজারে" finds "ব্রাউজার". */
const BENGALI_SUFFIXES = [
  'গুলোর',
  'গুলো',
  'গুলি',
  'দের',
  'েরা',
  'ের',
  'কে',
  'রা',
  'টা',
  'টি',
  'তে',
  'ে',
  'র',
];

const isBengali = (word: string) => /[ঀ-৿]/.test(word);

function stem(word: string): string {
  if (isBengali(word)) {
    // Up to two passes, so "ব্রাউজারে" and "ব্রাউজার" reach the same stem.
    let current = word;
    for (let pass = 0; pass < 2; pass += 1) {
      const suffix = BENGALI_SUFFIXES.find(
        (s) => current.endsWith(s) && Array.from(current).length - Array.from(s).length >= 2,
      );
      if (!suffix) break;
      current = current.slice(0, current.length - suffix.length);
    }
    return current;
  }
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** The words worth matching on, folded and lightly stemmed. */
export function tokens(text: string): string[] {
  const words = fold(text).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (Array.from(word).length < 2 || STOPWORDS.has(word)) continue;
    out.push(stem(word));
  }
  return out;
}

/** Two words match when they are equal, or one begins the other (both at least 4 letters: "browse"/"browser"). */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return (
    Array.from(a).length >= 4 && Array.from(b).length >= 4 && (a.startsWith(b) || b.startsWith(a))
  );
}
