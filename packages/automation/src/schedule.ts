import type { AutomationTrigger } from '@allaya/validation';

const MINUTE = 60_000;

/** `HH:MM` → hours and minutes. The trigger schema guarantees the shape. */
function clock(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(':');
  return { hours: Number(h), minutes: Number(m) };
}

/** A local date-time. On a day when the clocks skip an hour, JavaScript moves it forward — never backward. */
const local = (from: Date, dayOffset: number, hours: number, minutes: number): Date =>
  new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, hours, minutes, 0, 0);

/**
 * The next moment (epoch ms) strictly after `after` at which the trigger fires, in the computer's local time, or
 * `undefined` when it never fires by itself (manual, a new-file watch) or has no future left (a past "once").
 */
export function nextRun(trigger: AutomationTrigger, after: number): number | undefined {
  switch (trigger.kind) {
    case 'manual':
    case 'new_file':
      return undefined;
    case 'once':
      return trigger.at > after ? trigger.at : undefined;
    case 'interval':
      return after + trigger.everyMinutes * MINUTE;
    case 'daily': {
      const { hours, minutes } = clock(trigger.time);
      const start = new Date(after);
      // Eight days always contains every weekday, whatever the current time of day is.
      for (let offset = 0; offset <= 8; offset += 1) {
        const candidate = local(start, offset, hours, minutes);
        if (candidate.getTime() > after && trigger.days.includes(candidate.getDay())) {
          return candidate.getTime();
        }
      }
      return undefined;
    }
    case 'monthly': {
      const { hours, minutes } = clock(trigger.time);
      const start = new Date(after);
      for (let offset = 0; offset <= 2; offset += 1) {
        const candidate = new Date(
          start.getFullYear(),
          start.getMonth() + offset,
          trigger.day,
          hours,
          minutes,
          0,
          0,
        );
        if (candidate.getTime() > after) return candidate.getTime();
      }
      return undefined;
    }
  }
}

/**
 * What comes after a run that was due at `scheduledFor` and is being handled at `now`. Intervals stay on their own
 * beat (no drift, and no burst of make-up runs after a long pause); the rest simply look for the next occurrence.
 */
export function nextRunAfterFiring(
  trigger: AutomationTrigger,
  scheduledFor: number,
  now: number,
): number | undefined {
  if (trigger.kind === 'interval') {
    const step = trigger.everyMinutes * MINUTE;
    const behind = Math.max(0, now - scheduledFor);
    return scheduledFor + (Math.floor(behind / step) + 1) * step;
  }
  return nextRun(trigger, Math.max(now, scheduledFor));
}

/** Why a trigger cannot be used right now, or `undefined` if it can. */
export function triggerProblem(trigger: AutomationTrigger, now: number): 'in_the_past' | undefined {
  return trigger.kind === 'once' && trigger.at <= now ? 'in_the_past' : undefined;
}

/** Sorted, de-duplicated weekdays, so the same set is always stored (and described) the same way. */
export function normalizeTrigger(trigger: AutomationTrigger): AutomationTrigger {
  if (trigger.kind === 'daily') {
    return { ...trigger, days: [...new Set(trigger.days)].sort((a, b) => a - b) };
  }
  if (trigger.kind === 'new_file') {
    return { ...trigger, folder: trigger.folder.replace(/[\\/]+$/u, '') };
  }
  return trigger;
}
