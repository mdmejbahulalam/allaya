import { redactString } from '@allaya/shared';
import { fold } from './text';

/**
 * Things Allaya will not keep. This is the first line of defence against remembering something dangerous; the second
 * is that nothing the model proposes is saved without the person's yes, and the third is that a memory reaches the
 * AI only as fenced data that cannot change its rules (see `prompt.ts`).
 */
export type GuardReason = 'looks_secret' | 'tries_to_change_rules';

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
const asciiDigits = (text: string) =>
  text.replace(/[০-৯]/g, (digit) => String(BENGALI_DIGITS.indexOf(digit)));

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
};

const CREDENTIAL_PHRASE =
  /(?:password|passcode|passwd|pin|otp|cvv|cvc|secret key|পাসওয়ার্ড|পাসকোড|পিন|ওটিপি|সিভিভি)\s*(?:is|are|:|=|হলো|হল|হচ্ছে)\s*\S{3,}/iu;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LONG_TOKEN =
  /(?<![A-Za-z0-9_\-+/=])(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{32,}/;

/** True when the text holds something that looks like a password, key, token or card number. */
export function looksSecret(text: string): boolean {
  if (redactString(text) !== text) return true;
  if (PRIVATE_KEY.test(text) || CREDENTIAL_PHRASE.test(text) || LONG_TOKEN.test(text)) return true;
  for (const match of asciiDigits(text).matchAll(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

const RULE_CHANGING: RegExp[] = [
  /\b(?:ignore|disregard|override|bypass|skip|disable)\b[^.\n]{0,40}\b(?:instructions?|rules?|confirmations?|permissions?|safety|restrictions?|guardrails?)\b/i,
  /\b(?:without|no need to|don'?t|do not|never|stop)\s+(?:asking|ask|confirm(?:ing|ation)?|prompt(?:ing)?)\b/i,
  /\balways\s+(?:allow|approve|say yes|confirm|agree|go ahead)\b/i,
  /\bauto[- ]?(?:approve|confirm|allow|accept)\b/i,
  /\byou (?:are|have) (?:now )?(?:allowed|permitted|authori[sz]ed)\b/i,
  /অনুমতি\s*ছাড়া/u,
  /জিজ্ঞে?স[া]?\s*(?:না\s*করে|ছাড়াই?)/u,
  /নিশ্চিত\s*না\s*করে/u,
  /নিয়ম(?:গুলো)?\s*(?:উপেক্ষা|মানবে\s*না|ভাঙ)/u,
];

/** Text that reads like an order to Allaya about its own rules. Only checked on what the model proposes. */
export function triesToChangeRules(text: string): boolean {
  const folded = fold(text);
  return RULE_CHANGING.some((pattern) => pattern.test(folded));
}

/** Why a text may not be kept, or `undefined` when it may. `fromModel` adds the check for rule-changing text. */
export function checkText(texts: readonly string[], fromModel: boolean): GuardReason | undefined {
  const joined = texts.join('\n');
  if (looksSecret(joined)) return 'looks_secret';
  if (fromModel && triesToChangeRules(joined)) return 'tries_to_change_rules';
  return undefined;
}
