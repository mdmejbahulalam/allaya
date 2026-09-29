import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  extractTimeExpressions,
  formatIsoDate,
  parseTimeExpression,
  weekdayOf,
  type CivilDate,
  type TimeExpression,
  type Weekday,
} from '@allaya/language';

const TODAY: CivilDate = { year: 2026, month: 9, day: 28 }; // a Monday
const iso = (d: CivilDate) => formatIsoDate(d);
const parse = (text: string, weekStartsOn: Weekday = 6) =>
  parseTimeExpression(text, { today: TODAY, weekStartsOn });

function summarize(e: TimeExpression | undefined): string {
  if (!e) return 'none';
  switch (e.kind) {
    case 'point':
      return iso(e.date);
    case 'range':
      return `${iso(e.from)}..${iso(e.to)}`;
    case 'clock':
      return `${String(e.hour).padStart(2, '0')}:${String(e.minute).padStart(2, '0')}${e.meridiemKnown ? '' : '?'}`;
    case 'offset':
      return `+${e.minutes}m`;
    case 'ambiguous':
      return `ambiguous:${e.word}:${e.candidates.map(iso).join('|')}`;
  }
}

describe('civil date arithmetic (no time-zone dependence)', () => {
  it('the reference date is a Monday', () => expect(weekdayOf(TODAY)).toBe(1));
  it('adds days across month and year boundaries', () => {
    expect(iso(addDays({ year: 2026, month: 12, day: 31 }, 1))).toBe('2027-01-01');
    expect(iso(addDays({ year: 2026, month: 3, day: 1 }, -1))).toBe('2026-02-28');
    expect(iso(addDays({ year: 2024, month: 2, day: 28 }, 1))).toBe('2024-02-29'); // leap year
  });
  it('adds months clamping to the end of shorter months', () => {
    expect(iso(addMonths({ year: 2026, month: 3, day: 31 }, -1))).toBe('2026-02-28');
    expect(iso(addMonths({ year: 2026, month: 1, day: 15 }, -2))).toBe('2025-11-15');
  });
});

describe('relative ranges — Bengali, Banglish, English', () => {
  it.each([
    ['গত ৭ দিন', '2026-09-21..2026-09-28'],
    ['গত ৭ দিনের ফাইল', '2026-09-21..2026-09-28'],
    ['গত সাত দিনের', '2026-09-21..2026-09-28'],
    ['গত 7 দিন', '2026-09-21..2026-09-28'],
    ['last 7 days', '2026-09-21..2026-09-28'],
    ['past 30 days', '2026-08-29..2026-09-28'],
    ['gato 7 din', '2026-09-21..2026-09-28'],
    ['গত ২ সপ্তাহ', '2026-09-14..2026-09-28'],
    ['last 2 weeks', '2026-09-14..2026-09-28'],
    ['গত ১ মাস', '2026-08-28..2026-09-28'],
    ['গত তিন মাসের', '2026-06-28..2026-09-28'],
  ])('%s → %s', (text, expected) => expect(summarize(parse(text))).toBe(expected));

  it('calendar weeks follow the configured first day of the week (Saturday in Bangladesh)', () => {
    expect(summarize(parse('গত সপ্তাহ', 6))).toBe('2026-09-19..2026-09-25');
    expect(summarize(parse('এই সপ্তাহ', 6))).toBe('2026-09-26..2026-09-28');
    expect(summarize(parse('last week', 0))).toBe('2026-09-20..2026-09-26'); // Sunday start
    expect(summarize(parse('last week', 1))).toBe('2026-09-21..2026-09-27'); // Monday start
    expect(summarize(parse('আগামী সপ্তাহ', 6))).toBe('2026-10-03..2026-10-09');
  });

  it('calendar months and years', () => {
    expect(summarize(parse('গত মাস'))).toBe('2026-08-01..2026-08-31');
    expect(summarize(parse('এই মাসে'))).toBe('2026-09-01..2026-09-28');
    expect(summarize(parse('গত বছর'))).toBe('2025-01-01..2025-12-31');
    expect(summarize(parse('this year'))).toBe('2026-01-01..2026-09-28');
  });
});

describe('single days and the ambiguous "কাল"', () => {
  it.each([
    ['আজ', '2026-09-28'],
    ['আজকে', '2026-09-28'],
    ['today', '2026-09-28'],
    ['gতকাল'.replace('g', 'গ'), '2026-09-27'],
    ['yesterday', '2026-09-27'],
    ['gotokal', '2026-09-27'],
    ['আগামীকাল', '2026-09-29'],
    ['tomorrow', '2026-09-29'],
    ['agamikal', '2026-09-29'],
    ['গত পরশু', '2026-09-26'],
    ['আগামী পরশু', '2026-09-30'],
    ['৩ দিন আগে', '2026-09-25'],
    ['তিন দিন আগে', '2026-09-25'],
    ['3 days ago', '2026-09-25'],
    ['2 weeks ago', '2026-09-14'],
  ])('%s → %s', (text, expected) => expect(summarize(parse(text))).toBe(expected));

  it('"কাল" and "পরশু" are genuinely two-valued: reported as ambiguous, never guessed', () => {
    expect(summarize(parse('কাল'))).toBe('ambiguous:kal:2026-09-27|2026-09-29');
    expect(summarize(parse('কালকে'))).toBe('ambiguous:kal:2026-09-27|2026-09-29');
    expect(summarize(parse('kal'))).toBe('ambiguous:kal:2026-09-27|2026-09-29');
    expect(summarize(parse('পরশু'))).toBe('ambiguous:poroshu:2026-09-30|2026-09-26');
  });

  it('does not match "কাল" inside other words (সকাল, ভোরকাল…)', () => {
    expect(parse('সকাল')).toBeUndefined();
    expect(parse('চিরকাল')).toBeUndefined();
  });
});

describe('weekdays', () => {
  it.each([
    ['আগামী শুক্রবার', '2026-10-02'], // Friday 9/25 is already past
    ['next friday', '2026-10-02'],
    ['গত রবিবার', '2026-09-27'],
    ['গত সোমবার', '2026-09-21'], // today is Monday: "last Monday" is a week ago, not today
    ['next monday', '2026-10-05'],
    ['শুক্রবার', '2026-10-02'],
    ['সোমবার', '2026-09-28'], // bare weekday that is today → today
    ['শনিবার', '2026-10-03'],
  ])('%s → %s', (text, expected) => expect(summarize(parse(text))).toBe(expected));

  it('does not read ordinary English words as weekdays ("sat", "sun", "wed")', () => {
    expect(parse('I sat down')).toBeUndefined();
    expect(parse('the sun was out, we wed')).toBeUndefined();
  });
});

describe('clock times: the Bengali way of speaking the 12-hour clock', () => {
  it.each([
    ['সকাল ৯টা', '09:00'],
    ['সকাল ৯টায়', '09:00'],
    ['ভোর ৫টা', '05:00'],
    ['দুপুর ১টা', '13:00'],
    ['দুপুর ১২টা', '12:00'],
    ['বিকাল ৪টা', '16:00'],
    ['বিকেল ৪টা', '16:00'],
    ['সন্ধ্যা ৬টা', '18:00'],
    ['রাত ১০টা', '22:00'],
    ['রাত ১২টা', '00:00'], // midnight
    ['রাত ২টা', '02:00'], // small hours
    ['রাত ৯টা', '21:00'],
    ['shokal 9 ta', '09:00'],
    ['dupur 1 ta', '13:00'],
    ['রাত ১১টা', '23:00'],
  ])('%s → %s', (text, expected) => expect(summarize(parse(text))).toBe(expected));

  it('সাড়ে (½), সোয়া (¼), পৌনে (¾ of the previous hour)', () => {
    expect(summarize(parse('বিকাল সাড়ে ৫টা'))).toBe('17:30');
    expect(summarize(parse('সোয়া ৩টা'))).toBe('03:15?');
    expect(summarize(parse('দুপুর সোয়া ৩টা'))).toBe('15:15');
    expect(summarize(parse('সকাল পৌনে ৮টা'))).toBe('07:45');
    expect(summarize(parse('রাত পৌনে ১২টা'))).toBe('23:45');
    expect(summarize(parse('পৌনে ১টা'))).toBe('12:45?');
    expect(summarize(parse('সাড়ে তিনটা'))).toBe('03:30?'); // number words work too
    expect(summarize(parse('সাড়ে ৫টা'))).toBe('05:30?');
  });

  it('digits, 24-hour and am/pm forms; meridiem-unknown times are flagged for confirmation', () => {
    expect(summarize(parse('৯:৩০'))).toBe('09:30?');
    expect(summarize(parse('18:30'))).toBe('18:30');
    expect(summarize(parse('সকাল ৯:৩০'))).toBe('09:30');
    expect(summarize(parse('9:30 am'))).toBe('09:30');
    expect(summarize(parse('6 pm'))).toBe('18:00');
    expect(summarize(parse('12 am'))).toBe('00:00');
    expect(summarize(parse('12 pm'))).toBe('12:00');
    expect(summarize(parse('৯টায়'))).toBe('09:00?');
    expect(summarize(parse('25:99'))).toBe('none');
  });

  it('a bare "৩টা" is a COUNT (3 files), not 3 o\'clock', () => {
    expect(parse('৩টা ফাইল খুলে দাও')).toBeUndefined();
    expect(parse('দুটো folder বানাও')).toBeUndefined();
    expect(summarize(parse('৩টায় ফাইল খুলে দাও'))).toBe('03:00?');
  });
});

describe('offsets', () => {
  it.each([
    ['৩০ মিনিট পর', '+30m'],
    ['30 minit por', '+30m'],
    ['in 2 hours', '+120m'],
    ['এক ঘণ্টা পর', '+60m'],
    ['after 10 minutes', '+10m'],
    ['১ দিন পর', '+1440m'],
  ])('%s → %s', (text, expected) => expect(summarize(parse(text))).toBe(expected));
});

describe('extraction from full commands', () => {
  it('finds spans and prefers the longest match (গত ৭ দিন beats the bare word দিন)', () => {
    const found = extractTimeExpressions('আমার Downloads folder থেকে গত ৭ দিনের PDF খুঁজে দাও', {
      today: TODAY,
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe('গত ৭ দিনের');
    expect(summarize(found[0]!.expression)).toBe('2026-09-21..2026-09-28');
  });

  it('finds several expressions in one command, in order', () => {
    const found = extractTimeExpressions('আজ বিকাল ৪টায় report খুলে দিও, গতকালের ফাইল সহ', {
      today: TODAY,
    });
    expect(found.map((f) => summarize(f.expression))).toEqual([
      '2026-09-28',
      '16:00',
      '2026-09-27',
    ]);
    expect(found.every((f, i) => i === 0 || f.start >= found[i - 1]!.end)).toBe(true);
  });

  it('"খুলে দিন" (please open) is not a duration: দিন is only a unit after a number', () => {
    expect(extractTimeExpressions('Chrome খুলে দিন', { today: TODAY })).toEqual([]);
    expect(extractTimeExpressions('ফাইলটা খুলে দাও', { today: TODAY })).toEqual([]);
  });

  it('returns nothing for text with no time expression', () => {
    expect(extractTimeExpressions('Open my Downloads folder', { today: TODAY })).toEqual([]);
    expect(extractTimeExpressions('', { today: TODAY })).toEqual([]);
  });
});

describe('case suffixes on day words', () => {
  it.each([
    ['গতকালের ফাইল', '2026-09-27'],
    ['আজকের ফাইল', '2026-09-28'],
    ['আগামীকালের meeting', '2026-09-29'],
  ])('%s → %s', (text, expected) => expect(summarize(parse(text))).toBe(expected));

  it('"আজকাল" (nowadays) is not "today"', () => {
    expect(parse('আজকাল ফাইল কম')).toBeUndefined();
  });
});
