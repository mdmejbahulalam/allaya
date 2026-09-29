import { afterEach, describe, expect, it } from 'vitest';
import { nextRun } from '@allaya/automation';
import type { AutomationTrigger } from '@allaya/validation';

const original = process.env['TZ'];
afterEach(() => {
  if (original === undefined) delete process.env['TZ'];
  else process.env['TZ'] = original;
});
const inZone = (zone: string) => {
  process.env['TZ'] = zone;
};
const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();
const HOUR = 3_600_000;

describe('schedules across daylight-saving changes', () => {
  const everyDay = (time: string): AutomationTrigger => ({
    kind: 'daily',
    time,
    days: [0, 1, 2, 3, 4, 5, 6],
  });

  it('keeps a daily 09:00 at 09:00 local time when the clocks change (spring and autumn)', () => {
    inZone('America/New_York');
    for (const [start, hoursBetween] of [
      [at(2026, 3, 6, 10), 23], // 8 March: an hour is skipped
      [at(2026, 10, 30, 10), 25], // 1 November: an hour is repeated
    ] as const) {
      const first = nextRun(everyDay('09:00'), start)!;
      const second = nextRun(everyDay('09:00'), first)!;
      expect(new Date(first).getHours()).toBe(9);
      expect(new Date(second).getHours()).toBe(9);
      expect((second - first) / HOUR).toBe(hoursBetween);
    }
  });

  it('a time that does not exist that day (02:30 when 02:00 jumps to 03:00) still runs, once, an hour later', () => {
    inZone('America/New_York');
    const first = nextRun(everyDay('02:30'), at(2026, 3, 7, 12))!;
    const day = new Date(first);
    expect([day.getMonth(), day.getDate(), day.getHours(), day.getMinutes()]).toEqual([
      2, 8, 3, 30,
    ]);
    // …and the day after is back to 02:30, with no second run on the 8th.
    const next = nextRun(everyDay('02:30'), first)!;
    expect([new Date(next).getDate(), new Date(next).getHours()]).toEqual([9, 2]);
  });

  it('a repeated time (01:30 twice) runs once, not twice', () => {
    inZone('America/New_York');
    const first = nextRun(everyDay('01:30'), at(2026, 10, 31, 12))!;
    const second = nextRun(everyDay('01:30'), first)!;
    expect(new Date(second).getDate()).toBe(2); // 1 November's run happened once; the next is 2 November
    expect(first).toBeLessThan(second);
    expect((second - first) / HOUR).toBeGreaterThanOrEqual(24);
  });

  it('is monotone through a whole year in zones with and without daylight saving', () => {
    for (const zone of [
      'America/New_York',
      'Europe/London',
      'Australia/Lord_Howe',
      'Asia/Dhaka',
      'UTC',
    ]) {
      inZone(zone);
      let cursor = at(2026, 1, 1);
      for (let i = 0; i < 420; i += 1) {
        const next = nextRun(everyDay('02:30'), cursor)!;
        expect(next, zone).toBeGreaterThan(cursor);
        expect(next - cursor, zone).toBeLessThanOrEqual(26 * HOUR);
        cursor = next;
      }
    }
  });

  it('Dhaka (no daylight saving) is exactly 24 hours apart', () => {
    inZone('Asia/Dhaka');
    const first = nextRun(everyDay('09:00'), at(2026, 3, 7, 10))!;
    expect((nextRun(everyDay('09:00'), first)! - first) / HOUR).toBe(24);
  });
});
