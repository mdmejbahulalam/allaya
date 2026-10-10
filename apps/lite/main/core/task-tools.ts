import { AllayaError } from '@allaya/shared';
import { MODEL_NEEDS, type ModelNeed } from '../../shared/model-choice';
import { checkSchedule, type Schedule } from '../../shared/schedule';
import type { TaskService } from './tasks';
import type { Tool } from './tools';

export const TASKS_GROUP = 'tasks';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A schedule in words, for the person to read. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'manual':
      return 'only when you run it';
    case 'once':
      return `once, on ${new Date(schedule.at).toLocaleString('en-CA', { hour12: false })}`;
    case 'every':
      return schedule.minutes % 60 === 0
        ? `every ${schedule.minutes / 60 === 1 ? 'hour' : `${schedule.minutes / 60} hours`}`
        : `every ${schedule.minutes} minutes`;
    case 'daily': {
      const days =
        schedule.days.length === 0 || schedule.days.length === 7
          ? 'every day'
          : schedule.days.map((d) => DAYS[d]).join(', ');
      return `${days} at ${schedule.time}`;
    }
  }
}

const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/** The schedule the model described, as a real one; anything unclear is refused with what to fix. */
export function scheduleFromArgs(args: Record<string, unknown>, now: Date): Schedule {
  const when = str(args, 'when') ?? 'manual';
  const bad = (message: string) => new AllayaError(message, { code: 'INVALID_INPUT' });
  switch (when) {
    case 'manual':
      return { kind: 'manual' };
    case 'once': {
      const text = str(args, 'at');
      const at = text ? new Date(text).getTime() : Number.NaN;
      if (!Number.isFinite(at))
        throw bad('For a one-time task, "at" must be a date and time such as 2026-10-12T09:30.');
      return { kind: 'once', at };
    }
    case 'every': {
      const minutes = Number(args['every_minutes']);
      if (!Number.isInteger(minutes) || minutes < 5)
        throw bad('"every_minutes" must be a whole number, at least 5.');
      return { kind: 'every', minutes };
    }
    case 'daily': {
      const time = str(args, 'time');
      if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
        throw bad('"time" must be like 08:30 (24-hour).');
      const raw = Array.isArray(args['days']) ? (args['days'] as unknown[]) : [];
      const days = raw
        .map((d) =>
          typeof d === 'number'
            ? d
            : DAYS.findIndex((name) => name.toLowerCase() === String(d).toLowerCase()),
        )
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      return { kind: 'daily', time, days: [...new Set(days)] };
    }
    default:
      void now;
      throw bad('"when" must be one of: manual, once, every, daily.');
  }
}

/**
 * What the model may do about tasks. Making one is a change that will run on its own later, so it always asks the
 * person first; listing them only looks.
 */
export function createTaskTools(tasks: TaskService, now: () => Date): Tool[] {
  return [
    {
      name: 'create_task',
      group: TASKS_GROUP,
      effect: 'write',
      description:
        'Create a task that Allaya will carry out later or on a schedule, with the right model for it. Use it when the ' +
        'user asks for something to be done regularly or at a set time ("every morning…", "remind me at 5…"). The user is asked to allow it.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short name.' },
          instructions: {
            type: 'string',
            description:
              'Everything needed to do it, as if telling someone who has no other context. Include what to deliver.',
          },
          when: {
            type: 'string',
            enum: ['manual', 'once', 'every', 'daily'],
            description: 'manual = only when the user runs it.',
          },
          at: {
            type: 'string',
            description: 'For once: local date and time, like 2026-10-12T09:30.',
          },
          every_minutes: {
            type: 'number',
            description: 'For every: minutes between runs (at least 5).',
          },
          time: { type: 'string', description: 'For daily: time of day like 08:30 (24-hour).' },
          days: {
            type: 'array',
            items: { type: 'string' },
            description: 'For daily: weekday names; leave out for every day.',
          },
          model_need: {
            type: 'string',
            enum: [...MODEL_NEEDS],
            description:
              'What the task needs from its model: fast (simple, cheap), balanced, smart (hard reasoning), vision, long (very long documents).',
          },
          use_browser: {
            type: 'boolean',
            description: 'Whether the task needs to open and read web pages (default true).',
          },
        },
        required: ['title', 'instructions'],
      },
      summarize: (args) => {
        const title = str(args, 'title') ?? 'a task';
        try {
          return `Create the task “${title}” — ${describeSchedule(scheduleFromArgs(args, now()))}`;
        } catch {
          return `Create the task “${title}”`;
        }
      },
      check(args) {
        if (!str(args, 'title') || !str(args, 'instructions'))
          throw new AllayaError('A task needs a title and instructions.', {
            code: 'INVALID_INPUT',
          });
        const schedule = scheduleFromArgs(args, now());
        const problem = checkSchedule(schedule, now());
        if (problem)
          throw new AllayaError('That time has already passed. Pick a time in the future.', {
            code: 'INVALID_INPUT',
          });
      },
      async run(args) {
        const title = str(args, 'title') as string;
        const instructions = str(args, 'instructions') as string;
        const schedule = scheduleFromArgs(args, now());
        const need = str(args, 'model_need');
        const model =
          need && (MODEL_NEEDS as readonly string[]).includes(need)
            ? ((await tasks.modelFor(need as ModelNeed)) ?? null)
            : null;
        const created = tasks.create(
          {
            title,
            instructions,
            model,
            schedule,
            groups: args['use_browser'] === false ? [] : ['browser'],
          },
          'allaya',
        );
        return `Created the task “${created.title}” (${describeSchedule(created.schedule)}). It is in the Tasks list.`;
      },
    },
    {
      name: 'list_tasks',
      group: TASKS_GROUP,
      effect: 'read',
      description: 'List the tasks the user has, with when each runs and how its last run went.',
      inputSchema: { type: 'object', properties: {} },
      summarize: () => 'List tasks',
      run() {
        const all = tasks.list();
        if (all.length === 0) return Promise.resolve('There are no tasks.');
        return Promise.resolve(
          all
            .map(
              (t) =>
                `- ${t.title}: ${describeSchedule(t.schedule)}${t.enabled ? '' : ' (off)'}${t.lastRun ? `; last run ${t.lastRun.status}` : ''}`,
            )
            .join('\n'),
        );
      },
    },
  ];
}
