import { z } from 'zod';

/** When a task runs. Times are the computer's local time. */
export const scheduleSchema = z.discriminatedUnion('kind', [
  /** Only when the person says so. */
  z.object({ kind: z.literal('manual') }),
  /** Once, at this moment (milliseconds since 1970). */
  z.object({ kind: z.literal('once'), at: z.number().int().min(0) }),
  /** Every so many minutes (at least five). */
  z.object({
    kind: z.literal('every'),
    minutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60),
  }),
  /** At this time of day, on these days (0 is Sunday); no days means every day. */
  z.object({
    kind: z.literal('daily'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    days: z.array(z.number().int().min(0).max(6)).max(7),
  }),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

const MINUTE = 60_000;

/**
 * The next moment this schedule says to run, after `from`. Null when there is none: a task run by hand, or one that
 * has already had its one time. For a repeating task `from` is when it last started (or was made), so a task that
 * was missed is run once, not once for every missed time.
 */
export function nextRun(schedule: Schedule, from: Date): Date | null {
  switch (schedule.kind) {
    case 'manual':
      return null;
    case 'once':
      return schedule.at > from.getTime() ? new Date(schedule.at) : null;
    case 'every':
      return new Date(from.getTime() + schedule.minutes * MINUTE);
    case 'daily': {
      const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number];
      const days = schedule.days.length > 0 ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
      for (let ahead = 0; ahead <= 7; ahead += 1) {
        const day = new Date(
          from.getFullYear(),
          from.getMonth(),
          from.getDate() + ahead,
          hours,
          minutes,
          0,
          0,
        );
        if (day.getTime() > from.getTime() && days.includes(day.getDay())) return day;
      }
      return null;
    }
  }
}

/** What the person is told when saving a schedule that cannot work. */
export type ScheduleProblem = 'in_the_past' | 'no_days';

export function checkSchedule(schedule: Schedule, now: Date): ScheduleProblem | undefined {
  if (schedule.kind === 'once' && schedule.at <= now.getTime()) return 'in_the_past';
  return undefined;
}
