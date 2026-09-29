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
  confirmationApproved: {
    bn: 'ঠিক আছে, করছি।',
    en: 'Okay, going ahead.',
  },
  confirmationRejected: {
    bn: 'ঠিক আছে, করছি না।',
    en: "Okay, I won't do it.",
  },
  confirmationNeedsScreen: {
    bn: 'এটা স্ক্রিনে নিশ্চিত করতে হবে — বোতামে চাপ দিন।',
    en: 'This one has to be confirmed on the screen — please use the button.',
  },
  confirmationWaiting: {
    bn: (summary: number | string) =>
      `একটা প্রশ্ন অপেক্ষা করছে: ${summary} — “হ্যাঁ” বা “না” বলুন, অথবা বোতাম ব্যবহার করুন।`,
    en: (summary: number | string) =>
      `A question is waiting: ${summary} — say “yes” or “no”, or use the buttons.`,
  },
  toolLimit: {
    bn: (steps: number | string) =>
      `${typeof steps === 'number' ? format(steps, 'bn') : steps}টি ধাপের পর থেমে গেছি। বাকিটা করতে বলুন।`,
    en: (steps: number | string) =>
      `I stopped after ${steps} steps. Ask me to continue if you want the rest.`,
  },
} as const;

export type ReplyKey = keyof typeof REPLIES;

type ReplyValue = string | ((arg: number | string) => string);

/** Looks up a reply. `arg` is only used by keys whose text depends on a number or a phrase. */
export function reply(key: ReplyKey, language: ReplyLanguage, arg: number | string = 1): string {
  const value = REPLIES[key][language] as ReplyValue;
  return typeof value === 'function' ? value(arg) : value;
}
