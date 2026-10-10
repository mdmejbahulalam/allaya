import type { Lang } from '../i18n';

const locale = (lang: Lang) => (lang === 'bn' ? 'bn-BD' : 'en-GB');

/** A moment in the person's words and clock: "Mon, 12 Oct, 09:30" (the year only when it is not this year). */
export function formatWhen(ms: number, lang: Lang, now: Date = new Date()): string {
  const date = new Date(ms);
  return new Intl.DateTimeFormat(locale(lang), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** The name of a weekday (0 is Sunday). */
export function weekdayName(day: number, lang: Lang, style: 'long' | 'short' = 'long'): string {
  // 7 January 2024 was a Sunday.
  return new Intl.DateTimeFormat(locale(lang), { weekday: style }).format(
    new Date(2024, 0, 7 + day),
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The value a `datetime-local` field wants, in the computer's time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
