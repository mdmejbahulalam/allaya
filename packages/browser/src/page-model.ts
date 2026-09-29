/**
 * What the model is told about a web page, and how Allaya judges the things on it. A page is *untrusted input*:
 * its text can be written by anyone, including someone trying to talk the model into doing something. So the
 * page is described to the model as data, the interesting controls are classified by what they would DO (pay,
 * send, delete, log in) and by what they would receive (a password, a card number), and text that looks like an
 * instruction to an AI is flagged.
 */

export type ElementRole =
  | 'link'
  | 'button'
  | 'textbox'
  | 'searchbox'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'tab'
  | 'menuitem'
  | 'other';

export interface ElementInfo {
  /** `e<generation>_<n>`: valid only for the snapshot it came from. */
  ref: string;
  role: ElementRole;
  /** What a person would call it: label, visible text, aria-label, placeholder. */
  name: string;
  tag: string;
  /** `password`, `email`, `text`… for inputs. */
  inputType?: string | undefined;
  autocomplete?: string | undefined;
  /** Absolute destination of a link. */
  href?: string | undefined;
  disabled: boolean;
  checked?: boolean | undefined;
  /** Never set for sensitive fields. */
  value?: string | undefined;
  /** Inside a `<form>`: pressing Enter or a submit button would send it. */
  inForm: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible text, cut to the requested length. */
  text: string;
  truncated: boolean;
  elements: ElementInfo[];
  elementsTruncated: boolean;
  /** Text that reads like an instruction to an AI system (a prompt-injection attempt). */
  suspiciousText: string[];
  /** Increases every time the page is read; refs from older snapshots are refused. */
  generation: number;
}

// ── What a control would do ─────────────────────────────────────────────────────────────────────────────────

export type Consequence = 'none' | 'sign_in' | 'sends' | 'deletes' | 'pays';

const word = (list: string[]) =>
  new RegExp(`(?:^|[^\\p{L}])(?:${list.join('|')})(?:$|[^\\p{L}])`, 'iu');
const sub = (list: string[]) => new RegExp(list.join('|'), 'iu');

// Bengali has no word boundaries in the regex sense, so those are matched as substrings.
const PAYS = [
  word([
    'buy',
    'buy now',
    'purchase',
    'pay',
    'pay now',
    'checkout',
    'check out',
    'place order',
    'complete order',
    'confirm order',
    'order now',
    'subscribe',
    'donate',
    'upgrade',
    'add payment',
  ]),
  sub([
    'কিনুন',
    'কিনে নিন',
    'অর্ডার',
    'পেমেন্ট',
    'পরিশোধ',
    'চেকআউট',
    'সাবস্ক্রাইব',
    'দান করুন',
    'ক্রয় করুন',
  ]),
];
const DELETES = [
  word([
    'delete',
    'remove',
    'erase',
    'discard',
    'clear all',
    'close account',
    'deactivate',
    'cancel subscription',
    'unsubscribe',
    'empty trash',
    'terminate',
  ]),
  sub(['মুছুন', 'মুছে ফেলুন', 'ডিলিট', 'সরিয়ে ফেলুন', 'অ্যাকাউন্ট বন্ধ']),
];
const SENDS = [
  word([
    'send',
    'submit',
    'post',
    'publish',
    'tweet',
    'reply',
    'share',
    'confirm',
    'apply',
    'book',
    'reserve',
    'register',
    'sign up',
    'signup',
    'create account',
    'agree',
    'accept',
    'authorize',
    'allow',
    'grant',
    'save changes',
    'update profile',
  ]),
  sub([
    'পাঠান',
    'জমা দিন',
    'সাবমিট',
    'প্রকাশ করুন',
    'পোস্ট করুন',
    'শেয়ার করুন',
    'নিশ্চিত করুন',
    'রেজিস্টার',
    'নিবন্ধন',
    'সম্মত',
    'অনুমতি দিন',
  ]),
];
const SIGN_IN = [
  word([
    'sign in',
    'signin',
    'log in',
    'login',
    'log on',
    'continue with google',
    'continue with facebook',
    'continue with apple',
  ]),
  sub(['লগইন', 'লগ ইন', 'সাইন ইন']),
];

const matches = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

/** What clicking this control would most likely do, judged by its visible name. Ordered worst-first. */
export function consequenceOf(
  element: Pick<ElementInfo, 'name' | 'role' | 'inputType' | 'tag'>,
): Consequence {
  const name = element.name.normalize('NFC');
  const submitLike =
    element.role === 'button' ||
    element.inputType === 'submit' ||
    element.inputType === 'image' ||
    element.tag === 'button';
  if (matches(PAYS, name)) return 'pays';
  if (matches(DELETES, name)) return 'deletes';
  if (matches(SIGN_IN, name)) return 'sign_in';
  if (matches(SENDS, name)) return 'sends';
  // An unnamed submit button still submits something.
  if (submitLike && element.inputType === 'submit' && name.trim() === '') return 'sends';
  return 'none';
}

// ── What a field would receive ──────────────────────────────────────────────────────────────────────────────

export type SensitiveKind = 'password' | 'payment' | 'one_time_code' | 'identity';

const PAYMENT = sub([
  'card.?number',
  'credit.?card',
  'debit.?card',
  'cvv',
  'cvc',
  'security.?code',
  'expir',
  'cc-',
  'কার্ড নম্বর',
  'ক্রেডিট কার্ড',
  'ডেবিট কার্ড',
]);
const OTP = sub([
  'one-time',
  'one.?time.?code',
  'otp',
  'verification.?code',
  'security.?code',
  '2fa',
  'authenticator',
  'passcode',
  'ওটিপি',
  'ভেরিফিকেশন কোড',
  'যাচাইকরণ কোড',
]);
const IDENTITY = sub([
  'social.?security',
  '\\bssn\\b',
  'national.?id',
  '\\bnid\\b',
  'passport',
  'tax.?id',
  'জাতীয় পরিচয়',
  'পাসপোর্ট',
]);
const PASSWORD_WORDS = word(['password', 'passcode', 'pin', 'secret']);

/**
 * Fields that receive secrets. Allaya never types into these: passwords, card numbers, one-time codes and identity
 * numbers must be entered by the person. (They can sign in themselves in the browser window; the profile keeps it.)
 */
export function sensitiveKind(
  element: Pick<ElementInfo, 'name' | 'inputType' | 'autocomplete'>,
): SensitiveKind | undefined {
  const type = (element.inputType ?? '').toLowerCase();
  const auto = (element.autocomplete ?? '').toLowerCase();
  const name = element.name;
  if (type === 'password' || auto.includes('password')) return 'password';
  if (auto.includes('one-time-code') || OTP.test(name) || OTP.test(auto)) return 'one_time_code';
  if (auto.startsWith('cc-') || auto.includes(' cc-') || PAYMENT.test(name) || PAYMENT.test(auto))
    return 'payment';
  if (IDENTITY.test(name) || IDENTITY.test(auto)) return 'identity';
  if (PASSWORD_WORDS.test(name)) return 'password';
  return undefined;
}

// ── Prompt-injection signals ────────────────────────────────────────────────────────────────────────────────

const INJECTION: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?)/i,
  /disregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?)/i,
  /forget\s+(?:all\s+|everything\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|context)/i,
  /(?:new|updated|real)\s+instructions?\s*:/i,
  /system\s+prompt/i,
  /you\s+(?:must|should|will)\s+now\s+(?:act|behave|respond|ignore|send|visit|open|click|type)/i,
  /(?:ai|assistant|llm|agent|chatbot|language model)[,:]?\s+(?:please\s+)?(?:you\s+must|you\s+should|do\s+the\s+following|your\s+task\s+is|ignore)/i,
  /do\s+not\s+(?:tell|inform|mention|reveal|alert)\s+(?:this\s+to\s+)?the\s+user/i,
  /(?:send|forward|email|upload|post|leak|exfiltrate)\s+(?:all\s+|any\s+|the\s+|this\s+|your\s+)?(?:conversation|chat|files?|passwords?|credentials|api\s*keys?|private|secrets?|contents?)\b/i,
  /আগের\s+(?:সব\s+)?নির্দেশ(?:না|গুলো)?\s+(?:উপেক্ষা|ভুলে|অগ্রাহ্য)/,
  /ব্যবহারকারীকে\s+(?:কিছু\s+)?(?:বলো|জানিও)\s*না/,
];

/** Sentences of `text` that look like instructions aimed at an AI. Bounded and cheap. */
export function findInjection(text: string, limit = 3): string[] {
  const found: string[] = [];
  const sample = text.length > 60_000 ? text.slice(0, 60_000) : text;
  for (const pattern of INJECTION) {
    const match = pattern.exec(sample);
    if (!match) continue;
    const start = Math.max(0, match.index - 30);
    found.push(
      sample
        .slice(start, match.index + match[0].length + 40)
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (found.length >= limit) break;
  }
  return found;
}

/** Collapses runs of blank lines and trailing spaces, and cuts to `max` characters (never in the middle of one). */
export function tidyText(raw: string, max: number): { text: string; truncated: boolean } {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- strip control characters the page might smuggle in
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > max
    ? { text: chars.slice(0, max).join(''), truncated: true }
    : { text: cleaned, truncated: false };
}
