import type { ModelRef, TaskInput, TaskView } from '../../../shared/ipc';
import type { Schedule } from '../../../shared/schedule';
import type { TextKey } from '../i18n';
import { toLocalInput } from './time';

export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;
export const BROWSER_GROUP = 'browser';

/** A task as the form holds it while the person is still typing. */
export interface Draft {
  title: string;
  instructions: string;
  model: ModelRef | null;
  kind: Schedule['kind'];
  /** For "once": what a `datetime-local` field holds. */
  at: string;
  everyN: string;
  unit: 'minutes' | 'hours';
  time: string;
  days: number[];
  browser: boolean;
  /** The tool groups of the connected apps the task may use. */
  apps: string[];
}

export const emptyDraft = (): Draft => ({
  title: '',
  instructions: '',
  model: null,
  kind: 'manual',
  at: '',
  everyN: '1',
  unit: 'hours',
  time: '08:00',
  days: [],
  browser: true,
  apps: [],
});

/** `appGroups` are the groups of the apps that are connected now: the ones the form has a switch for. */
export function draftFromTask(task: TaskView, appGroups: readonly string[] = []): Draft {
  const draft: Draft = {
    ...emptyDraft(),
    title: task.title,
    instructions: task.instructions,
    model: task.model,
    kind: task.schedule.kind,
    browser: task.groups.includes(BROWSER_GROUP),
    apps: task.groups.filter((g) => appGroups.includes(g)),
  };
  const { schedule } = task;
  if (schedule.kind === 'once') draft.at = toLocalInput(schedule.at);
  if (schedule.kind === 'every') {
    const hours = schedule.minutes % 60 === 0;
    draft.unit = hours ? 'hours' : 'minutes';
    draft.everyN = String(hours ? schedule.minutes / 60 : schedule.minutes);
  }
  if (schedule.kind === 'daily') {
    draft.time = schedule.time;
    draft.days = [...schedule.days];
  }
  return draft;
}

export type DraftErrors = Partial<
  Record<'title' | 'instructions' | 'at' | 'every' | 'time', TextKey>
>;

/**
 * The task the form describes, or what to fix. `others` are the task's other tool groups (those the form has no switch
 * for, such as an app that has since been removed), kept as they are.
 */
export function draftToInput(
  draft: Draft,
  now: Date,
  others: readonly string[] = [],
): { input: TaskInput; errors?: undefined } | { input?: undefined; errors: DraftErrors } {
  const errors: DraftErrors = {};
  if (!draft.title.trim()) errors.title = 'tasks.err.title';
  if (!draft.instructions.trim()) errors.instructions = 'tasks.err.instructions';
  let schedule: Schedule = { kind: 'manual' };
  switch (draft.kind) {
    case 'manual':
      break;
    case 'once': {
      const at = draft.at ? new Date(draft.at).getTime() : Number.NaN;
      if (!Number.isFinite(at)) errors.at = 'tasks.err.once';
      else if (at <= now.getTime()) errors.at = 'tasks.err.in_the_past';
      else schedule = { kind: 'once', at };
      break;
    }
    case 'every': {
      const n = Number(draft.everyN);
      const minutes = draft.unit === 'hours' ? n * 60 : n;
      if (
        !draft.everyN.trim() ||
        !Number.isInteger(minutes) ||
        minutes < MIN_EVERY_MINUTES ||
        minutes > MAX_EVERY_MINUTES
      )
        errors.every = 'tasks.err.every';
      else schedule = { kind: 'every', minutes };
      break;
    }
    case 'daily': {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) errors.time = 'tasks.err.time';
      else
        schedule = { kind: 'daily', time: draft.time, days: [...draft.days].sort((a, b) => a - b) };
      break;
    }
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    input: {
      title: draft.title.trim(),
      instructions: draft.instructions.trim(),
      model: draft.model,
      schedule,
      groups: [...(draft.browser ? [BROWSER_GROUP] : []), ...draft.apps, ...others],
    },
  };
}
