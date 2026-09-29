/**
 * Replies Allaya produces itself, without a model, in the user's language. These are conversation *content*
 * (they are stored in the transcript), so they live with the language engine rather than the UI string tables.
 *
 * Every key has both a Bengali and an English form; a parity test enforces it.
 */
export type ReplyLanguage = 'bn' | 'en';

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
export const toBengaliDigits = (value: number | string): string =>
  String(value).replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)]!);

const format = (n: number, language: ReplyLanguage) =>
  language === 'bn' ? toBengaliDigits(n) : String(n);

export const REPLIES = {
  languageSwitchedBn: {
    bn: 'ঠিক আছে, এখন থেকে বাংলায় কথা বলব।',
    en: "Sure — I'll reply in Bengali from now on.",
  },
  languageSwitchedEn: {
    bn: 'ঠিক আছে, এখন থেকে ইংরেজিতে কথা বলব।',
    en: "Sure — I'll reply in English from now on.",
  },
  stopped: {
    bn: (count: number) =>
      count > 1 ? `${format(count, 'bn')}টি কাজ থামিয়ে দিয়েছি।` : 'থামিয়ে দিয়েছি।',
    en: (count: number) => (count > 1 ? `Stopped ${count} tasks.` : 'Stopped.'),
  },
  nothingRunning: {
    bn: 'এখন কিছু চলছে না।',
    en: 'Nothing is running right now.',
  },
  cancelled: {
    bn: 'ঠিক আছে, বাতিল করেছি।',
    en: 'Okay, cancelled.',
  },
  nothingToCancel: {
    bn: 'বাতিল করার মতো কিছু নেই।',
    en: "There's nothing to cancel.",
  },
} as const;

export type ReplyKey = keyof typeof REPLIES;

type ReplyValue = string | ((count: number) => string);

/** Looks up a reply. `count` is only used by keys whose text depends on a number. */
export function reply(key: ReplyKey, language: ReplyLanguage, count = 1): string {
  const value = REPLIES[key][language] as ReplyValue;
  return typeof value === 'function' ? value(count) : value;
}
