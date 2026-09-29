import { canonicalize, normalizeDigits } from './script';

/**
 * Bengali number words. Bengali has an irregular, unique word for every number 1–100 (there is no
 * "twenty-one = twenty + one"), so a full table is required rather than a rule.
 */
const WORDS_0_TO_100 =
  'শূন্য এক দুই তিন চার পাঁচ ছয় সাত আট নয় দশ ' +
  'এগারো বারো তেরো চৌদ্দ পনেরো ষোলো সতেরো আঠারো উনিশ বিশ ' +
  'একুশ বাইশ তেইশ চব্বিশ পঁচিশ ছাব্বিশ সাতাশ আটাশ ঊনত্রিশ ত্রিশ ' +
  'একত্রিশ বত্রিশ তেত্রিশ চৌত্রিশ পঁয়ত্রিশ ছত্রিশ সাঁইত্রিশ আটত্রিশ ঊনচল্লিশ চল্লিশ ' +
  'একচল্লিশ বিয়াল্লিশ তেতাল্লিশ চুয়াল্লিশ পঁয়তাল্লিশ ছেচল্লিশ সাতচল্লিশ আটচল্লিশ ঊনপঞ্চাশ পঞ্চাশ ' +
  'একান্ন বায়ান্ন তিপ্পান্ন চুয়ান্ন পঞ্চান্ন ছাপ্পান্ন সাতান্ন আটান্ন ঊনষাট ষাট ' +
  'একষট্টি বাষট্টি তেষট্টি চৌষট্টি পঁয়ষট্টি ছেষট্টি সাতষট্টি আটষট্টি ঊনসত্তর সত্তর ' +
  'একাত্তর বাহাত্তর তিয়াত্তর চুয়াত্তর পঁচাত্তর ছিয়াত্তর সাতাত্তর আটাত্তর ঊনআশি আশি ' +
  'একাশি বিরাশি তিরাশি চুরাশি পঁচাশি ছিয়াশি সাতাশি আটাশি ঊননব্বই নব্বই ' +
  'একানব্বই বিরানব্বই তিরানব্বই চুরানব্বই পঁচানব্বই ছিয়ানব্বই সাতানব্বই আটানব্বই নিরানব্বই একশো';

const BN_WORDS = WORDS_0_TO_100.split(' ');

const NUMBER_WORDS = new Map<string, number>();
BN_WORDS.forEach((word, value) => NUMBER_WORDS.set(canonicalize(word), value));
// Common alternate spellings.
for (const [word, value] of [
  ['একশ', 100],
  ['একশত', 100],
  ['চোদ্দ', 14],
  ['ষোল', 16],
  ['ঊনিশ', 19],
  ['উনিশ', 19],
  ['ছাব্বিশ', 26],
  ['ছয়', 6],
  ['ছয়টা', 6],
  ['আধ', 0.5],
] as const) {
  NUMBER_WORDS.set(canonicalize(word), value);
}

/** Romanised number words. Only safe to use next to a unit word (e.g. "sat din"), since some collide with English. */
const BANGLISH_NUMBER_WORDS = new Map<string, number>([
  ['ek', 1],
  ['dui', 2],
  ['tin', 3],
  ['char', 4],
  ['panch', 5],
  ['pach', 5],
  ['choy', 6],
  ['chhoy', 6],
  ['shat', 7],
  ['sat', 7],
  ['aat', 8],
  ['noy', 9],
  ['dosh', 10],
  ['dosh', 10],
  ['bish', 20],
  ['tirish', 30],
]);

/** Suffixes that attach to a numeral: ৩টা, তিনটি, পাঁচখানা, ৭টি. */
const NUMERAL_CLASSIFIERS = /(?:টা|টি|খানা|খানি|জন|টাকা)$/;

/** Value of a Bengali number word (with optional classifier), digits ("৭"), or undefined. */
export function bengaliNumberValue(raw: string): number | undefined {
  const word = canonicalize(raw).replace(NUMERAL_CLASSIFIERS, '');
  if (word === '') return undefined;
  const direct = NUMBER_WORDS.get(word);
  if (direct !== undefined) return direct;
  if (/^[০-৯0-9]+$/.test(word)) return Number(normalizeDigits(word));
  return undefined;
}

export function banglishNumberValue(raw: string): number | undefined {
  return BANGLISH_NUMBER_WORDS.get(raw.toLowerCase());
}

/**
 * Replaces Bengali number words and digits with Latin digits, token by token:
 * "গত সাত দিন" → "গত 7 দিন", "৩টা" → "3টা". Latin text is untouched.
 */
export function replaceNumberWords(text: string): string {
  return normalizeDigits(text)
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s*$/.test(part)) return part;
      const classifier = NUMERAL_CLASSIFIERS.exec(part)?.[0] ?? '';
      const value = NUMBER_WORDS.get(canonicalize(part.replace(NUMERAL_CLASSIFIERS, '')));
      return value !== undefined ? `${value}${classifier}` : part;
    })
    .join('');
}
