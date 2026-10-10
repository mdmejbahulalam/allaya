import type { Schedule } from '../../../shared/schedule';
import type { Translator } from '../i18n';
import { formatWhen, weekdayName } from './time';

/** A schedule in the person's words: "Every day at 08:30", "Mon, Fri at 08:30", "Every 2 hours". */
export function describeSchedule(t: Translator, schedule: Schedule): string {
  switch (schedule.kind) {
    case 'manual':
      return t.t('tasks.when.manual');
    case 'once':
      return t.t('tasks.when.once', { when: formatWhen(schedule.at, t.lang) });
    case 'every': {
      const { minutes } = schedule;
      if (minutes === 60) return t.t('tasks.when.everyHour');
      if (minutes % 60 === 0) return t.t('tasks.when.everyHours', { n: minutes / 60 });
      return t.t('tasks.when.everyMinutes', { n: minutes });
    }
    case 'daily': {
      if (schedule.days.length === 0 || schedule.days.length === 7)
        return t.t('tasks.when.daily', { time: schedule.time });
      const days = [...schedule.days]
        .sort((a, b) => a - b)
        .map((d) => weekdayName(d, t.lang, 'short'))
        .join(', ');
      return t.t('tasks.when.days', { days, time: schedule.time });
    }
  }
}
