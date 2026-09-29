import { z } from 'zod';
import { defineTool } from '../types';

const WEEKDAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  bn: ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'],
} as const;

/** The first real tool: harmless, read-only, and lets the whole call → result → answer loop be proven end to end. */
export const getDatetime = defineTool({
  name: 'get_datetime',
  description:
    "Returns the computer's current local date, time and weekday. Use it when the user asks what time or day it is, or before resolving words like 'today' or 'tomorrow'. It does not change anything.",
  category: 'system',
  parameters: z.object({}).strict(),
  readOnly: true,
  risk: 'LOW',
  requires: [],
  describe: (_args, language) =>
    language === 'bn' ? 'বর্তমান তারিখ ও সময় দেখা হচ্ছে' : 'Checking the current date and time',
  async execute(_args, context) {
    const now = context.now;
    return {
      iso: now.toISOString(),
      localDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      localTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      weekday: WEEKDAYS.en[now.getDay()],
      weekdayBn: WEEKDAYS.bn[now.getDay()],
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },
});
