import { canonicalize, normalizeDigits } from './script';
import { bengaliNumberValue } from './numbers';

/**
 * Deterministic date/time understanding for Bengali, Banglish and English.
 *
 * Everything works on *civil dates* (year/month/day) rather than timestamps, so results never depend on the
 * machine's time zone or on DST — a search "since 7 days ago" means the same calendar day everywhere.
 *
 * Bengali-specific behaviour worth knowing:
 *  - "কাল" means BOTH yesterday and tomorrow (and "পরশু" both the day after tomorrow and the day before
 *    yesterday); it is returned as `ambiguous` instead of being silently guessed.
 *  - A number followed by "টা" is a *count* ("৩টা ফাইল" = 3 files) unless a time-of-day word, a fraction word
 *    (সাড়ে/সোয়া/পৌনে), or a locative ("৩টায়") marks it as a clock time.
 *  - Time-of-day words shift the 12-hour clock: রাত ১২টা = 00:00, রাত ২টা = 02:00, রাত ১০টা = 22:00.
 */

export interface CivilDate {
  year: number;
  month: number; // 1–12
  day: number;
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // Sunday = 0

export function civilFromDate(date: Date): CivilDate {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

const toUtc = (d: CivilDate) => Date.UTC(d.year, d.month - 1, d.day);
const fromUtc = (ms: number): CivilDate => {
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromUtc(toUtc(date) + days * 86_400_000);
}

export function weekdayOf(date: CivilDate): Weekday {
  return new Date(toUtc(date)).getUTCDay() as Weekday;
}

export function addMonths(date: CivilDate, months: number): CivilDate {
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(date.day, daysInMonth) };
}

export const formatIsoDate = (d: CivilDate) =>
  `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

export const sameDate = (a: CivilDate, b: CivilDate) => toUtc(a) === toUtc(b);

export interface TimeContext {
  today: CivilDate;
  /** First day of the calendar week. Bangladesh: Saturday (6). Default follows the locale. */
  weekStartsOn?: Weekday;
}

export type TimeExpression =
  | { kind: 'point'; date: CivilDate }
  | { kind: 'range'; from: CivilDate; to: CivilDate }
  /** `meridiemKnown` is false for "সাড়ে ৫টা" / "৯টায়": 5 could be AM or PM, so a scheduler should confirm. */
  | { kind: 'clock'; hour: number; minute: number; meridiemKnown: boolean }
  | { kind: 'offset'; minutes: number }
  /** "কাল" / "পরশু": genuinely two-valued in Bengali. The caller decides from context, or asks. */
  | { kind: 'ambiguous'; word: 'kal' | 'poroshu'; candidates: CivilDate[] };

export interface ExtractedTime {
  expression: TimeExpression;
  /** The matched source text and its offsets in the input. */
  text: string;
  start: number;
  end: number;
}

// ── Vocabulary ────────────────────────────────────────────────────────────────
const B = String.raw`(?<![\p{L}\p{M}\p{N}])`;
const E = String.raw`(?![\p{L}\p{M}\p{N}])`;
/** Bengali suffixes that may trail a word (দিনের, সপ্তাহে, মাসগুলো …). */
const SFX = String.raw`[ঀ-৿]*`;

const NUMBER_WORD_ALTERNATION = [
  'শূন্য',
  'এক',
  'দুই',
  'তিন',
  'চার',
  'পাঁচ',
  'ছয়',
  'সাত',
  'আট',
  'নয়',
  'দশ',
  'এগারো',
  'বারো',
  'তেরো',
  'চৌদ্দ',
  'চোদ্দ',
  'পনেরো',
  'ষোলো',
  'ষোল',
  'সতেরো',
  'আঠারো',
  'উনিশ',
  'ঊনিশ',
  'বিশ',
  'একুশ',
  'বাইশ',
  'তেইশ',
  'চব্বিশ',
  'পঁচিশ',
  'ছাব্বিশ',
  'সাতাশ',
  'আটাশ',
  'ঊনত্রিশ',
  'ত্রিশ',
  'পঞ্চাশ',
  'ষাট',
  'সত্তর',
  'আশি',
  'নব্বই',
  'একশ',
  'একশো',
]
  .sort((a, b) => b.length - a.length)
  .join('|');

const BANGLISH_NUMBERS: Record<string, number> = {
  ek: 1,
  dui: 2,
  tin: 3,
  char: 4,
  panch: 5,
  pach: 5,
  choy: 6,
  chhoy: 6,
  shat: 7,
  sat: 7,
  aat: 8,
  noy: 9,
  dosh: 10,
  bish: 20,
  tirish: 30,
};
const ENGLISH_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  thirty: 30,
};

/** A number: digits (Latin/Bengali), Bengali number words, or Banglish/English words. */
const NUM = String.raw`(?:[০-৯0-9]+(?:\.[০-৯0-9]+)?|${NUMBER_WORD_ALTERNATION}|${Object.keys(BANGLISH_NUMBERS).join('|')}|${Object.keys(ENGLISH_NUMBERS).join('|')})`;

function numberValue(raw: string): number {
  const lower = raw.toLowerCase();
  if (lower in BANGLISH_NUMBERS) return BANGLISH_NUMBERS[lower]!;
  if (lower in ENGLISH_NUMBERS) return ENGLISH_NUMBERS[lower]!;
  const bn = bengaliNumberValue(raw);
  if (bn !== undefined) return bn;
  return Number(normalizeDigits(raw));
}

type Unit = 'day' | 'week' | 'month' | 'year' | 'hour' | 'minute';
const UNIT_PATTERNS: Array<[Unit, string]> = [
  ['day', String.raw`(?:দিন${SFX}|din(?:er|e)?|days?)`],
  ['week', String.raw`(?:সপ্তাহ${SFX}|shoptah(?:o|er|e)?|hapta|weeks?)`],
  ['month', String.raw`(?:মাস${SFX}|mash(?:er|e)?|months?)`],
  ['year', String.raw`(?:বছর${SFX}|bochor(?:er|e)?|years?)`],
  ['hour', String.raw`(?:ঘণ্টা${SFX}|ঘন্টা${SFX}|ghonta(?:r|y)?|hours?|hrs?)`],
  ['minute', String.raw`(?:মিনিট${SFX}|minit(?:er|e)?|minutes?|mins?)`],
];
const UNIT = `(?:${UNIT_PATTERNS.map(([, p]) => p).join('|')})`;

function unitOf(raw: string): Unit {
  const s = raw.toLowerCase();
  for (const [unit, pattern] of UNIT_PATTERNS)
    if (new RegExp(`^${pattern}$`, 'iu').test(s)) return unit;
  return 'day';
}

const PAST = String.raw`(?:গত|ager|gato|gata|last|past|previous)`;
const FUTURE = String.raw`(?:আগামী|আগামি|আসছে|agami|ashche|next|coming|upcoming)`;
const THIS = String.raw`(?:এই|ei|this|current)`;

const WEEKDAYS: Array<[Weekday, string]> = [
  [0, String.raw`(?:রবিবার|robibar|sunday)`],
  [1, String.raw`(?:সোমবার|shombar|sombar|monday)`],
  [2, String.raw`(?:মঙ্গলবার|mongolbar|tuesday)`],
  [3, String.raw`(?:বুধবার|budhbar|wednesday)`],
  [4, String.raw`(?:বৃহস্পতিবার|brihospotibar|brihaspatibar|thursday)`],
  [5, String.raw`(?:শুক্রবার|shukrobar|sukrobar|friday)`],
  [6, String.raw`(?:শনিবার|shonibar|sonibar|saturday)`],
];
const WEEKDAY = `(?:${WEEKDAYS.map(([, p]) => p).join('|')})`;
function weekdayFromWord(raw: string): Weekday {
  const s = raw.toLowerCase().normalize('NFC');
  for (const [day, pattern] of WEEKDAYS) if (new RegExp(`^${pattern}$`, 'iu').test(s)) return day;
  return 0;
}

// ── Extraction ───────────────────────────────────────────────────────────────
interface Rule {
  pattern: RegExp;
  build: (m: RegExpExecArray, ctx: Required<TimeContext>) => TimeExpression | undefined;
}

const startOfWeek = (date: CivilDate, weekStartsOn: Weekday): CivilDate => {
  const back = (weekdayOf(date) - weekStartsOn + 7) % 7;
  return addDays(date, -back);
};

const rx = (source: string) => new RegExp(source, 'giu');

/** Period-of-day → 24h hour. Encodes the Bengali convention for how the 12-hour clock is spoken. */
function to24h(period: string | undefined, hour12: number): number {
  const h = hour12 % 24;
  if (!period) return h;
  const p = period.toLowerCase();
  if (/^(ভোর|bhor)/u.test(p)) return h === 12 ? 0 : h; // ভোর ৫টা = 05:00
  if (/^(সকাল|shokal|sokal|morning|am)/u.test(p)) return h === 12 ? 0 : h; // সকাল ৯টা = 09:00
  if (/^(দুপুর|dupur|noon)/u.test(p)) return h === 12 ? 12 : h < 6 ? h + 12 : h; // দুপুর ১টা = 13:00
  if (/^(বিকাল|বিকেল|bikel|bikal|afternoon)/u.test(p)) return h < 12 ? h + 12 : h; // বিকাল ৪টা = 16:00
  if (/^(সন্ধ্যা|সন্ধ্যা|sondha|shondha|evening)/u.test(p)) return h < 12 ? h + 12 : h; // সন্ধ্যা ৬টা = 18:00
  if (/^(রাত|raat|rat|night)/u.test(p)) {
    if (h === 12) return 0; // রাত ১২টা = midnight
    if (h >= 5) return h + 12; // রাত ১০টা = 22:00
    return h; // রাত ২টা = 02:00 (small hours of the next day)
  }
  if (/^pm/u.test(p)) return h === 12 ? 12 : h + 12;
  return h;
}

const PERIOD = String.raw`(?:ভোর|bhor|সকাল${SFX}|shokal|sokal|morning|দুপুর${SFX}|dupur|noon|বিকাল${SFX}|বিকেল${SFX}|bikel|bikal|afternoon|সন্ধ্যা${SFX}|sondha|shondha|evening|রাত${SFX}|raat|rat|night)`;
const FRACTION = String.raw`(?:সাড়ে|সাড়ে|sare|সোয়া|soya|shoya|পৌনে|poune|pone)`;
const CLOCK_SUFFIX = String.raw`(?:টায়|টা|টার|ta|tay|টি|টার)?`;

function fractionMinutes(word: string): { minutes: number; hourDelta: number } {
  const w = word.toLowerCase();
  if (/^(সাড়ে|sare)/u.test(w)) return { minutes: 30, hourDelta: 0 };
  if (/^(সোয়া|soya|shoya)/u.test(w)) return { minutes: 15, hourDelta: 0 };
  return { minutes: 45, hourDelta: -1 }; // পৌনে ৮টা = 7:45
}

const RULES: Rule[] = [
  // ── ranges: past N units ("গত ৭ দিন", "last 7 days", "gato 7 din") ────────
  {
    pattern: rx(`${B}${PAST}\\s+(${NUM})\\s*(${UNIT})${E}`),
    build: (m, { today }) => {
      const amount = numberValue(m[1]!);
      const unit = unitOf(m[2]!);
      const from =
        unit === 'day'
          ? addDays(today, -amount)
          : unit === 'week'
            ? addDays(today, -7 * amount)
            : unit === 'month'
              ? addMonths(today, -amount)
              : unit === 'year'
                ? addMonths(today, -12 * amount)
                : undefined;
      return from ? { kind: 'range', from, to: today } : undefined;
    },
  },
  // ── "N days ago" ───────────────────────────────────────────────────────────
  {
    pattern: rx(`${B}(${NUM})\\s*(${UNIT})\\s*(?:আগে|age|ago)${E}`),
    build: (m, { today }) => {
      const amount = numberValue(m[1]!);
      const unit = unitOf(m[2]!);
      if (unit === 'day') return { kind: 'point', date: addDays(today, -amount) };
      if (unit === 'week') return { kind: 'point', date: addDays(today, -7 * amount) };
      if (unit === 'month') return { kind: 'point', date: addMonths(today, -amount) };
      return undefined;
    },
  },
  // ── "in N minutes" / "N মিনিট পর" ─────────────────────────────────────────
  {
    pattern: rx(`${B}(?:in|after)\\s+(${NUM})\\s*(${UNIT})${E}`),
    build: (m) => offset(numberValue(m[1]!), unitOf(m[2]!)),
  },
  {
    pattern: rx(`${B}(${NUM})\\s*(${UNIT})\\s*(?:পর|পরে|por|pore)${E}`),
    build: (m) => offset(numberValue(m[1]!), unitOf(m[2]!)),
  },
  // ── calendar ranges ──────────────────────────────────────────────────────────
  {
    pattern: rx(`${B}${PAST}\\s+(সপ্তাহ${SFX}|shoptah(?:o|er|e)?|weeks?)${E}`),
    build: (_m, { today, weekStartsOn }) => {
      const thisWeek = startOfWeek(today, weekStartsOn);
      return { kind: 'range', from: addDays(thisWeek, -7), to: addDays(thisWeek, -1) };
    },
  },
  {
    pattern: rx(`${B}${THIS}\\s+(সপ্তাহ${SFX}|shoptah(?:o|er|e)?|weeks?)${E}`),
    build: (_m, { today, weekStartsOn }) => ({
      kind: 'range',
      from: startOfWeek(today, weekStartsOn),
      to: today,
    }),
  },
  {
    pattern: rx(`${B}${FUTURE}\\s+(সপ্তাহ${SFX}|shoptah(?:o|er|e)?|weeks?)${E}`),
    build: (_m, { today, weekStartsOn }) => {
      const next = addDays(startOfWeek(today, weekStartsOn), 7);
      return { kind: 'range', from: next, to: addDays(next, 6) };
    },
  },
  {
    pattern: rx(`${B}${PAST}\\s+(মাস${SFX}|mash(?:er|e)?|months?)${E}`),
    build: (_m, { today }) => {
      const first = addMonths({ ...today, day: 1 }, -1);
      return { kind: 'range', from: first, to: addDays(addMonths(first, 1), -1) };
    },
  },
  {
    pattern: rx(`${B}${THIS}\\s+(মাস${SFX}|mash(?:er|e)?|months?)${E}`),
    build: (_m, { today }) => ({ kind: 'range', from: { ...today, day: 1 }, to: today }),
  },
  {
    pattern: rx(`${B}${PAST}\\s+(বছর${SFX}|bochor(?:er|e)?|years?)${E}`),
    build: (_m, { today }) => ({
      kind: 'range',
      from: { year: today.year - 1, month: 1, day: 1 },
      to: { year: today.year - 1, month: 12, day: 31 },
    }),
  },
  {
    pattern: rx(`${B}${THIS}\\s+(বছর${SFX}|bochor(?:er|e)?|years?)${E}`),
    build: (_m, { today }) => ({
      kind: 'range',
      from: { year: today.year, month: 1, day: 1 },
      to: today,
    }),
  },
  // ── weekdays ("আগামী শুক্রবার", "গত রবিবার", "next friday") ───────────────
  {
    pattern: rx(`${B}(${PAST}|${FUTURE})\\s+(${WEEKDAY})${E}`),
    build: (m, { today }) => {
      const target = weekdayFromWord(m[2]!);
      const isPast = new RegExp(`^${PAST}$`, 'iu').test(m[1]!);
      const current = weekdayOf(today);
      const delta = isPast ? -((current - target + 7) % 7 || 7) : (target - current + 7) % 7 || 7;
      return { kind: 'point', date: addDays(today, delta) };
    },
  },
  // ── single day words ────────────────────────────────────────────────────────
  {
    pattern: rx(`${B}(?:গতকাল(?:ের|কে|ও|ই)?|gotokal|gatokal|yesterday)${E}`),
    build: (_m, { today }) => ({ kind: 'point', date: addDays(today, -1) }),
  },
  {
    pattern: rx(`${B}(?:আগামীকাল(?:ের|কে|ও|ই)?|আগামিকাল|agamikal|tomorrow)${E}`),
    build: (_m, { today }) => ({ kind: 'point', date: addDays(today, 1) }),
  },
  {
    pattern: rx(`${B}(?:আজ(?:কের|কে|ের|ও|ই)?|aj|aaj|ajke|today)${E}`),
    build: (_m, { today }) => ({ kind: 'point', date: today }),
  },
  {
    pattern: rx(`${B}(?:গত|last)\\s+(?:পরশু|poroshu)${E}`),
    build: (_m, { today }) => ({ kind: 'point', date: addDays(today, -2) }),
  },
  {
    pattern: rx(`${B}(?:আগামী|next)\\s+(?:পরশু|poroshu)${E}`),
    build: (_m, { today }) => ({ kind: 'point', date: addDays(today, 2) }),
  },
  {
    pattern: rx(`${B}(?:পরশু|পরশুদিন|poroshu)${E}`),
    build: (_m, { today }) => ({
      kind: 'ambiguous',
      word: 'poroshu',
      candidates: [addDays(today, 2), addDays(today, -2)],
    }),
  },
  {
    pattern: rx(`${B}(?:কাল(?:কে|কের|ের|ও|ই)?|kal|kalke)${E}`),
    build: (_m, { today }) => ({
      kind: 'ambiguous',
      word: 'kal',
      candidates: [addDays(today, -1), addDays(today, 1)],
    }),
  },
  {
    pattern: rx(`${B}(${WEEKDAY})${E}`),
    build: (m, { today }) => nextWeekday(today, weekdayFromWord(m[1]!)),
  },

  // ── clock times ───────────────────────────────────────────────────────────
  // "সাড়ে ৫টা", "সোয়া ৩টা", "পৌনে ৮টা" (optionally after a period word)
  {
    pattern: rx(
      `${B}(?:(${PERIOD})\\s+)?(${FRACTION})\\s+(${NUM})\\s*${CLOCK_SUFFIX}(?:\\s*বাজে)?${E}`,
    ),
    build: (m) => {
      const { minutes, hourDelta } = fractionMinutes(m[2]!);
      const shifted = numberValue(m[3]!) + hourDelta; // পৌনে ৮টা → 7:45
      const hour12 = shifted <= 0 ? 12 : shifted; // পৌনে ১টা → 12:45
      return {
        kind: 'clock',
        hour: to24h(m[1], hour12),
        minute: minutes,
        meridiemKnown: m[1] !== undefined,
      };
    },
  },
  // "9:30", "18:30", "9:30 am", optionally after a period word
  {
    pattern: rx(`${B}(?:(${PERIOD})\\s+)?([০-৯0-9]{1,2}):([০-৯0-9]{2})\\s*(am|pm)?${E}`),
    build: (m) => {
      const hour = numberValue(m[2]!);
      const minute = numberValue(m[3]!);
      if (hour > 23 || minute > 59) return undefined;
      const stated = m[4] !== undefined || m[1] !== undefined;
      const is24h = hour > 12 || hour === 0;
      return {
        kind: 'clock',
        hour: is24h && !stated ? hour : to24h(m[4] ?? m[1], hour),
        minute,
        meridiemKnown: stated || is24h,
      };
    },
  },
  // "9 am", "6 PM"
  {
    pattern: rx(`${B}([০-৯0-9]{1,2})\\s*(am|pm)${E}`),
    build: (m) => {
      const hour = numberValue(m[1]!);
      return hour >= 1 && hour <= 12
        ? { kind: 'clock', hour: to24h(m[2], hour), minute: 0, meridiemKnown: true }
        : undefined;
    },
  },
  // "সকাল ৯টা", "রাত ১০টায", "dupur 1 ta" — a period word makes it unambiguously a time
  {
    pattern: rx(`${B}(${PERIOD})\\s+(${NUM})\\s*${CLOCK_SUFFIX}(?:\\s*বাজে)?${E}`),
    build: (m) => {
      const hour = numberValue(m[2]!);
      return hour >= 1 && hour <= 12
        ? { kind: 'clock', hour: to24h(m[1], hour), minute: 0, meridiemKnown: true }
        : undefined;
    },
  },
  // "৯টায", "3 tay", "৫টা বাজে": the locative/“strikes” marker (without one, "৩টা" is a count)
  {
    pattern: rx(`${B}(${NUM})\\s*(?:টায়|tay|টা\\s*বাজে|ta\\s*baje)${E}`),
    build: (m) => {
      const hour = numberValue(m[1]!);
      return hour >= 1 && hour <= 12
        ? { kind: 'clock', hour, minute: 0, meridiemKnown: false }
        : undefined;
    },
  },
];

function offset(amount: number, unit: Unit): TimeExpression | undefined {
  const minutes =
    unit === 'minute'
      ? amount
      : unit === 'hour'
        ? amount * 60
        : unit === 'day'
          ? amount * 1440
          : unit === 'week'
            ? amount * 10_080
            : undefined;
  return minutes === undefined ? undefined : { kind: 'offset', minutes };
}

function nextWeekday(today: CivilDate, target: Weekday): TimeExpression {
  const delta = (target - weekdayOf(today) + 7) % 7; // today counts when it is that weekday
  return { kind: 'point', date: addDays(today, delta) };
}

/**
 * Finds every date/time expression in `text`. Longer, more specific matches win over shorter ones that
 * overlap them (e.g. "গত ৭ দিন" beats the bare "দিন"; "সাড়ে ৫টা" beats "৫টা").
 */
export function extractTimeExpressions(input: string, context: TimeContext): ExtractedTime[] {
  const text = canonicalize(input);
  const ctx: Required<TimeContext> = {
    today: context.today,
    weekStartsOn: context.weekStartsOn ?? 6,
  };
  const candidates: ExtractedTime[] = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const expression = rule.build(match, ctx);
      if (!expression) continue;
      const start = match.index ?? 0;
      candidates.push({ expression, text: match[0], start, end: start + match[0].length });
    }
  }

  // Keep the longest match among overlaps; ties go to the earlier rule (rules are ordered by specificity).
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const chosen: ExtractedTime[] = [];
  for (const candidate of candidates) {
    if (!chosen.some((c) => candidate.start < c.end && candidate.end > c.start))
      chosen.push(candidate);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/** Convenience: the first expression in the text, if any. */
export function parseTimeExpression(
  input: string,
  context: TimeContext,
): TimeExpression | undefined {
  return extractTimeExpressions(input, context)[0]?.expression;
}

export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
