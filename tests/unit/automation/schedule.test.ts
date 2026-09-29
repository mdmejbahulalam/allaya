import { describe, expect, it } from 'vitest';
import {
  describeTrigger,
  nextRun,
  nextRunAfterFiring,
  normalizeTrigger,
  triggerProblem,
} from '@allaya/automation';
import { automationTriggerSchema, type AutomationTrigger } from '@allaya/validation';

/** Local time, so these tests mean the same in every time zone the machine may be set to. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();
const MIN = 60_000;

describe('nextRun', () => {
  it('never fires by itself for manual and watched-folder triggers', () => {
    expect(nextRun({ kind: 'manual' }, 0)).toBeUndefined();
    expect(nextRun({ kind: 'new_file', folder: 'Downloads' }, 0)).toBeUndefined();
  });

  it('fires "once" only while it is in the future', () => {
    const t = at(2026, 5, 1, 9);
    expect(nextRun({ kind: 'once', at: t }, t - 1)).toBe(t);
    expect(nextRun({ kind: 'once', at: t }, t)).toBeUndefined();
    expect(nextRun({ kind: 'once', at: t }, t + 1)).toBeUndefined();
  });

  it('adds the interval', () => {
    expect(nextRun({ kind: 'interval', everyMinutes: 30 }, 1000)).toBe(1000 + 30 * MIN);
  });

  it('finds the next time of day, today or on the next chosen day', () => {
    const daily: AutomationTrigger = { kind: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] };
    expect(nextRun(daily, at(2026, 5, 4, 8, 59))).toBe(at(2026, 5, 4, 9));
    expect(nextRun(daily, at(2026, 5, 4, 9, 0))).toBe(at(2026, 5, 5, 9));
    expect(nextRun(daily, at(2026, 5, 4, 23, 59))).toBe(at(2026, 5, 5, 9));
  });

  it('honours the chosen weekdays (2026-05-04 is a Monday)', () => {
    const weekdays: AutomationTrigger = { kind: 'daily', time: '18:30', days: [1, 2, 3, 4, 5] };
    expect(new Date(at(2026, 5, 4)).getDay()).toBe(1);
    expect(nextRun(weekdays, at(2026, 5, 8, 19))).toBe(at(2026, 5, 11, 18, 30)); // Friday evening → Monday
    const weekend: AutomationTrigger = { kind: 'daily', time: '10:00', days: [0, 6] };
    expect(nextRun(weekend, at(2026, 5, 4, 12))).toBe(at(2026, 5, 9, 10)); // Monday → Saturday
    const sunday: AutomationTrigger = { kind: 'daily', time: '10:00', days: [0] };
    expect(nextRun(sunday, at(2026, 5, 10, 10))).toBe(at(2026, 5, 17, 10)); // a week later
  });

  it('handles month ends and year ends', () => {
    const monthly: AutomationTrigger = { kind: 'monthly', day: 28, time: '08:00' };
    expect(nextRun(monthly, at(2026, 5, 10))).toBe(at(2026, 5, 28, 8));
    expect(nextRun(monthly, at(2026, 5, 28, 8))).toBe(at(2026, 6, 28, 8));
    expect(nextRun(monthly, at(2026, 12, 30))).toBe(at(2027, 1, 28, 8));
    const first: AutomationTrigger = { kind: 'monthly', day: 1, time: '00:00' };
    expect(nextRun(first, at(2026, 2, 28, 23, 59))).toBe(at(2026, 3, 1));
  });

  it('is always strictly in the future, and monotone, for every kind (a property over many starting points)', () => {
    const triggers: AutomationTrigger[] = [
      { kind: 'interval', everyMinutes: 5 },
      { kind: 'daily', time: '00:00', days: [0, 1, 2, 3, 4, 5, 6] },
      { kind: 'daily', time: '23:59', days: [3] },
      { kind: 'monthly', day: 15, time: '12:00' },
    ];
    for (const trigger of triggers) {
      let cursor = at(2026, 1, 1);
      for (let i = 0; i < 400; i += 1) {
        const next = nextRun(trigger, cursor)!;
        expect(next).toBeGreaterThan(cursor);
        cursor = next + (i % 7) * MIN;
      }
    }
  });
});

describe('nextRunAfterFiring', () => {
  it('keeps an interval on its own beat and never bursts after a long pause', () => {
    const every10: AutomationTrigger = { kind: 'interval', everyMinutes: 10 };
    const start = at(2026, 5, 1, 9);
    expect(nextRunAfterFiring(every10, start, start + 20_000)).toBe(start + 10 * MIN);
    // Two hours late: exactly one step ahead of now, on the original beat.
    const late = start + 125 * MIN;
    const next = nextRunAfterFiring(every10, start, late)!;
    expect(next).toBeGreaterThan(late);
    expect(next - start).toBe(130 * MIN);
    expect((next - start) % (10 * MIN)).toBe(0);
  });

  it('finds the next occurrence after now for the other kinds', () => {
    const daily: AutomationTrigger = { kind: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] };
    expect(nextRunAfterFiring(daily, at(2026, 5, 1, 9), at(2026, 5, 1, 9, 0))).toBe(
      at(2026, 5, 2, 9),
    );
    // Missed by days: the next occurrence, not a make-up for each day.
    expect(nextRunAfterFiring(daily, at(2026, 5, 1, 9), at(2026, 5, 6, 12))).toBe(
      at(2026, 5, 7, 9),
    );
    expect(nextRunAfterFiring({ kind: 'once', at: 5 }, 5, 10)).toBeUndefined();
  });
});

describe('triggers as data', () => {
  it('rejects a moment that has passed', () => {
    expect(triggerProblem({ kind: 'once', at: 100 }, 200)).toBe('in_the_past');
    expect(triggerProblem({ kind: 'once', at: 300 }, 200)).toBeUndefined();
    expect(triggerProblem({ kind: 'daily', time: '09:00', days: [1] }, 200)).toBeUndefined();
  });

  it('stores weekdays sorted and unique, and folders without a trailing slash', () => {
    expect(normalizeTrigger({ kind: 'daily', time: '09:00', days: [5, 1, 5, 3] })).toEqual({
      kind: 'daily',
      time: '09:00',
      days: [1, 3, 5],
    });
    expect(normalizeTrigger({ kind: 'new_file', folder: 'Downloads//' })).toEqual({
      kind: 'new_file',
      folder: 'Downloads',
    });
  });

  it('accepts what is valid and refuses what is not (every field is bounded, extra keys are refused)', () => {
    const ok = (value: unknown) => automationTriggerSchema.safeParse(value).success;
    expect(ok({ kind: 'manual' })).toBe(true);
    expect(ok({ kind: 'interval', everyMinutes: 5 })).toBe(true);
    expect(ok({ kind: 'interval', everyMinutes: 4 })).toBe(false); // too frequent
    expect(ok({ kind: 'interval', everyMinutes: 10_081 })).toBe(false);
    expect(ok({ kind: 'interval', everyMinutes: 5.5 })).toBe(false);
    expect(ok({ kind: 'daily', time: '24:00', days: [1] })).toBe(false);
    expect(ok({ kind: 'daily', time: '9:00', days: [1] })).toBe(false);
    expect(ok({ kind: 'daily', time: '09:00', days: [] })).toBe(false);
    expect(ok({ kind: 'daily', time: '09:00', days: [7] })).toBe(false);
    expect(ok({ kind: 'monthly', day: 29, time: '09:00' })).toBe(false);
    expect(ok({ kind: 'monthly', day: 0, time: '09:00' })).toBe(false);
    expect(ok({ kind: 'once', at: -1 })).toBe(false);
    expect(ok({ kind: 'new_file', folder: '' })).toBe(false);
    expect(ok({ kind: 'manual', extra: true })).toBe(false);
    expect(ok({ kind: 'cron', expression: '* * * * *' })).toBe(false);
    expect(ok(null)).toBe(false);
  });
});

describe('describeTrigger', () => {
  it.each<[string, AutomationTrigger, string, string]>([
    ['manual', { kind: 'manual' }, 'Only when you run it', 'শুধু আপনি চালালে'],
    [
      'every minutes',
      { kind: 'interval', everyMinutes: 30 },
      'Every 30 minutes',
      'প্রতি 30 মিনিট পর পর',
    ],
    ['every hour', { kind: 'interval', everyMinutes: 60 }, 'Every hour', 'প্রতি ঘণ্টায়'],
    [
      'every hours',
      { kind: 'interval', everyMinutes: 180 },
      'Every 3 hours',
      'প্রতি 3 ঘণ্টা পর পর',
    ],
    ['every day', { kind: 'interval', everyMinutes: 1440 }, 'Every day', 'প্রতিদিন'],
    [
      'daily',
      { kind: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] },
      'Every day at 09:00',
      'প্রতিদিন 09:00-এ',
    ],
    [
      'weekdays',
      { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
      'Weekdays at 09:00',
      'সপ্তাহের কর্মদিবসে 09:00-এ',
    ],
    [
      'weekend',
      { kind: 'daily', time: '10:30', days: [6, 0] },
      'Weekends at 10:30',
      'সপ্তাহান্তে 10:30-এ',
    ],
    [
      'some days',
      { kind: 'daily', time: '18:00', days: [3, 1] },
      'Every Monday, Wednesday at 18:00',
      'প্রতি সোমবার, বুধবার 18:00-এ',
    ],
    [
      'monthly',
      { kind: 'monthly', day: 5, time: '08:00' },
      'On day 5 of every month at 08:00',
      'প্রতি মাসের 5 তারিখে 08:00-এ',
    ],
    [
      'folder',
      { kind: 'new_file', folder: 'Downloads' },
      'When a new file appears in “Downloads”',
      '“Downloads” ফোল্ডারে নতুন ফাইল এলে',
    ],
  ])('%s', (_name, trigger, en, bn) => {
    expect(describeTrigger(trigger, 'en')).toBe(en);
    expect(describeTrigger(trigger, 'bn')).toBe(bn);
  });

  it('gives a one-off its date and time', () => {
    const text = describeTrigger({ kind: 'once', at: at(2026, 5, 1, 9, 30) }, 'en');
    expect(text).toMatch(/^Once, on /);
    expect(text).toMatch(/2026/);
    expect(describeTrigger({ kind: 'once', at: at(2026, 5, 1, 9, 30) }, 'bn')).toMatch(/^একবার, /);
  });
});
