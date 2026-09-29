import type { TranslationKey, Translator } from '@allaya/localization';
import type { AutomationInput, AutomationTrigger, AutomationView } from '@allaya/validation';
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from '@allaya/validation';

export const TRIGGER_KINDS = [
  'manual',
  'once',
  'interval',
  'daily',
  'monthly',
  'new_file',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export type IntervalUnit = 'minutes' | 'hours' | 'days';

export interface FormState {
  name: string;
  instruction: string;
  kind: TriggerKind;
  /** `datetime-local` value, in the computer's own time. */
  onceAt: string;
  everyValue: string;
  everyUnit: IntervalUnit;
  time: string;
  days: number[];
  day: string;
  folder: string;
  missed: 'skip' | 'run_once';
  planFirst: boolean;
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 };

const pad = (n: number) => String(n).padStart(2, '0');
export const toLocalInput = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function emptyForm(now: number): FormState {
  return {
    name: '',
    instruction: '',
    kind: 'daily',
    onceAt: toLocalInput(now + 60 * 60_000),
    everyValue: '30',
    everyUnit: 'minutes',
    time: '09:00',
    days: [...ALL_DAYS],
    day: '1',
    folder: '',
    missed: 'skip',
    planFirst: false,
  };
}

/** The form as it stands for an automation being edited. */
export function formFrom(automation: AutomationView, now: number): FormState {
  const form: FormState = {
    ...emptyForm(now),
    name: automation.name,
    instruction: automation.instruction,
    kind: automation.trigger.kind,
    missed: automation.options.missed,
    planFirst: automation.options.planFirst,
  };
  const { trigger } = automation;
  switch (trigger.kind) {
    case 'once':
      form.onceAt = toLocalInput(trigger.at);
      break;
    case 'interval': {
      const unit: IntervalUnit =
        trigger.everyMinutes % 1440 === 0
          ? 'days'
          : trigger.everyMinutes % 60 === 0
            ? 'hours'
            : 'minutes';
      form.everyUnit = unit;
      form.everyValue = String(trigger.everyMinutes / UNIT_MINUTES[unit]);
      break;
    }
    case 'daily':
      form.time = trigger.time;
      form.days = [...trigger.days];
      break;
    case 'monthly':
      form.time = trigger.time;
      form.day = String(trigger.day);
      break;
    case 'new_file':
      form.folder = trigger.folder;
      break;
    case 'manual':
      break;
  }
  return form;
}

export type FormField =
  'name' | 'instruction' | 'onceAt' | 'every' | 'days' | 'day' | 'folder' | 'time';

export type FormResult =
  | { ok: true; input: AutomationInput }
  | { ok: false; errors: Partial<Record<FormField, TranslationKey>> };

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Turns the form into what the backend takes, or says what is wrong with it (the backend checks again). */
export function buildInput(form: FormState, now: number): FormResult {
  const errors: Partial<Record<FormField, TranslationKey>> = {};
  const name = form.name.trim();
  const instruction = form.instruction.trim();
  if (!name) errors.name = 'automations.form.needName';
  if (!instruction) errors.instruction = 'automations.form.needInstruction';

  let trigger: AutomationTrigger = { kind: 'manual' };
  switch (form.kind) {
    case 'manual':
      break;
    case 'once': {
      const at = new Date(form.onceAt).getTime();
      if (!Number.isFinite(at) || at <= now) errors.onceAt = 'automations.form.past';
      else trigger = { kind: 'once', at };
      break;
    }
    case 'interval': {
      const every = Number(form.everyValue);
      const minutes = every * UNIT_MINUTES[form.everyUnit];
      if (
        !Number.isInteger(every) ||
        minutes < MIN_INTERVAL_MINUTES ||
        minutes > MAX_INTERVAL_MINUTES
      ) {
        errors.every = 'automations.form.tooOften';
      } else trigger = { kind: 'interval', everyMinutes: minutes };
      break;
    }
    case 'daily':
      if (!CLOCK.test(form.time)) errors.time = 'automations.form.badTime';
      if (form.days.length === 0) errors.days = 'automations.form.needDays';
      if (!errors.time && !errors.days) {
        trigger = {
          kind: 'daily',
          time: form.time,
          days: [...new Set(form.days)].sort((a, b) => a - b),
        };
      }
      break;
    case 'monthly': {
      const day = Number(form.day);
      if (!Number.isInteger(day) || day < 1 || day > 28) errors.day = 'automations.form.badDay';
      if (!CLOCK.test(form.time)) errors.time = 'automations.form.badTime';
      if (!errors.day && !errors.time) trigger = { kind: 'monthly', day, time: form.time };
      break;
    }
    case 'new_file': {
      const folder = form.folder.trim();
      if (!folder) errors.folder = 'automations.form.needFolder';
      else trigger = { kind: 'new_file', folder };
      break;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      name,
      instruction,
      trigger,
      options: { missed: form.missed, planFirst: form.planFirst },
    },
  };
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** One line saying when an automation starts, in the interface language. */
export function whenText(trigger: AutomationTrigger, t: Translator): string {
  switch (trigger.kind) {
    case 'manual':
      return t.t('automations.when.manual');
    case 'once':
      return t.t('automations.when.once', {
        when: t.formatDate(trigger.at, { dateStyle: 'medium', timeStyle: 'short' }),
      });
    case 'interval': {
      const minutes = trigger.everyMinutes;
      if (minutes % 1440 === 0) return t.t('automations.when.everyDays', { count: minutes / 1440 });
      if (minutes % 60 === 0) return t.t('automations.when.everyHours', { count: minutes / 60 });
      return t.t('automations.when.everyMinutes', { count: minutes });
    }
    case 'daily': {
      const days = [...new Set(trigger.days)].sort((a, b) => a - b);
      const time = trigger.time;
      if (days.length === 7) return t.t('automations.when.daily', { time });
      if (same(days, WEEKDAYS)) return t.t('automations.when.weekdays', { time });
      if (same(days, WEEKEND)) return t.t('automations.when.weekend', { time });
      return t.t('automations.when.someDays', {
        days: days.map((d) => t.t(`automations.day.long.${d}` as TranslationKey)).join(', '),
        time,
      });
    }
    case 'monthly':
      return t.t('automations.when.monthly', { day: trigger.day, time: trigger.time });
    case 'new_file':
      return t.t('automations.when.newFile', { folder: trigger.folder });
  }
}
