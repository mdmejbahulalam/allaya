import type { AutomationTrigger } from '@allaya/validation';

type Language = 'bn' | 'en';

const DAYS: Record<Language, readonly string[]> = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  bn: ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'],
};

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** One line saying when an automation starts, for a confirmation (the screen does the same with its own strings). */
export function describeTrigger(trigger: AutomationTrigger, language: Language): string {
  const bn = language === 'bn';
  switch (trigger.kind) {
    case 'manual':
      return bn ? 'শুধু আপনি চালালে' : 'Only when you run it';
    case 'once': {
      const when = new Date(trigger.at).toLocaleString(bn ? 'bn-BD' : 'en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      return bn ? `একবার, ${when}` : `Once, on ${when}`;
    }
    case 'interval': {
      const minutes = trigger.everyMinutes;
      if (minutes % 1440 === 0) {
        const days = minutes / 1440;
        return bn
          ? days === 1
            ? 'প্রতিদিন'
            : `প্রতি ${days} দিন পর পর`
          : days === 1
            ? 'Every day'
            : `Every ${days} days`;
      }
      if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return bn
          ? hours === 1
            ? 'প্রতি ঘণ্টায়'
            : `প্রতি ${hours} ঘণ্টা পর পর`
          : hours === 1
            ? 'Every hour'
            : `Every ${hours} hours`;
      }
      return bn ? `প্রতি ${minutes} মিনিট পর পর` : `Every ${minutes} minutes`;
    }
    case 'daily': {
      const days = [...new Set(trigger.days)].sort((a, b) => a - b);
      const names = DAYS[language];
      const which =
        days.length === 7
          ? bn
            ? 'প্রতিদিন'
            : 'Every day'
          : same(days, WEEKDAYS)
            ? bn
              ? 'সপ্তাহের কর্মদিবসে'
              : 'Weekdays'
            : same(days, WEEKEND)
              ? bn
                ? 'সপ্তাহান্তে'
                : 'Weekends'
              : bn
                ? `প্রতি ${days.map((d) => names[d]).join(', ')}`
                : `Every ${days.map((d) => names[d]).join(', ')}`;
      return bn ? `${which} ${trigger.time}-এ` : `${which} at ${trigger.time}`;
    }
    case 'monthly':
      return bn
        ? `প্রতি মাসের ${trigger.day} তারিখে ${trigger.time}-এ`
        : `On day ${trigger.day} of every month at ${trigger.time}`;
    case 'new_file':
      return bn
        ? `“${trigger.folder}” ফোল্ডারে নতুন ফাইল এলে`
        : `When a new file appears in “${trigger.folder}”`;
  }
}
