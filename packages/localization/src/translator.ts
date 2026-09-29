import en from './locales/en.json';
import bn from './locales/bn.json';

export const RESOURCE_LOCALES = ['en', 'bn'] as const;
export type ResourceLocale = (typeof RESOURCE_LOCALES)[number];
export type NumeralStyle = 'auto' | 'bengali' | 'latin';

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every message key in the English catalog (the source of truth). */
export type MessageKey = Paths<typeof en>;
/** Keys as callers write them: `files.count_one` / `_other` are addressed as `files.count`. */
type StripPlural<K> = K extends `${infer Base}_${'zero' | 'one' | 'two' | 'few' | 'many' | 'other'}`
  ? Base
  : K;
export type TranslationKey = StripPlural<MessageKey>;

export type MessageParams = Record<string, string | number>;

export const catalogs: Record<ResourceLocale, Record<string, unknown>> = { en, bn };

/** Flattens a nested catalog into `dotted.key → string`. */
export function flattenCatalog(
  catalog: Record<string, unknown>,
  prefix = '',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else if (value && typeof value === 'object')
      Object.assign(out, flattenCatalog(value as Record<string, unknown>, path));
  }
  return out;
}

const flat: Record<ResourceLocale, Record<string, string>> = {
  en: flattenCatalog(en),
  bn: flattenCatalog(bn),
};

const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBengaliDigits(input: string | number): string {
  return String(input).replace(/[0-9]/g, (d) => BENGALI_DIGITS[Number(d)] ?? d);
}

export function toLatinDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BENGALI_DIGITS.indexOf(d)));
}

/** Maps a BCP-47 tag or UI preference to a locale we have resources for. */
export function toResourceLocale(tag: string | undefined): ResourceLocale {
  return tag?.toLowerCase().startsWith('bn') ? 'bn' : 'en';
}

export function resolveUiLocale(
  preference: 'auto' | ResourceLocale,
  osLocale: string | undefined,
): ResourceLocale {
  return preference === 'auto' ? toResourceLocale(osLocale) : preference;
}

export type GreetingPeriod = 'morning' | 'afternoon' | 'evening' | 'night';

export function greetingPeriod(hour: number): GreetingPeriod {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

export interface Translator {
  readonly locale: ResourceLocale;
  /** BCP-47 tag used for Intl formatting (region-aware, e.g. `bn-BD`). */
  readonly formatLocale: string;
  readonly useBengaliDigits: boolean;
  t(key: TranslationKey, params?: MessageParams): string;
  /** True when `key` (or its plural forms) exists. */
  has(key: string): boolean;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatRelativeTime(value: Date | number, now?: number): string;
  formatDuration(ms: number): string;
  formatFileSize(bytes: number): string;
}

export interface TranslatorOptions {
  locale: ResourceLocale;
  numerals?: NumeralStyle;
  /** Region-aware tag for formatting; defaults to `bn-BD` / `en-US`. */
  formatLocale?: string;
  onMissing?: (key: string, locale: ResourceLocale) => void;
}

export function createTranslator(options: TranslatorOptions): Translator {
  const { locale, numerals = 'auto', onMissing } = options;
  const formatLocale = options.formatLocale ?? (locale === 'bn' ? 'bn-BD' : 'en-US');
  const useBengaliDigits = numerals === 'bengali' || (numerals === 'auto' && locale === 'bn');
  const numberingSystem = useBengaliDigits ? 'beng' : 'latn';
  const pluralRules = new Intl.PluralRules(formatLocale);

  const numberFormat = (opts?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(formatLocale, { numberingSystem, ...opts });

  const lookup = (key: string): string | undefined => flat[locale][key] ?? flat.en[key];

  const interpolate = (template: string, params?: MessageParams): string => {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params[name];
      if (value === undefined) return match;
      return typeof value === 'number' ? numberFormat().format(value) : value;
    });
  };

  const t: Translator['t'] = (key, params) => {
    let resolved: string | undefined;
    if (params && typeof params['count'] === 'number') {
      const category = pluralRules.select(params['count']);
      resolved = lookup(`${key}_${category}`) ?? lookup(`${key}_other`);
    }
    resolved ??= lookup(key);
    if (resolved === undefined) {
      onMissing?.(key, locale);
      return key;
    }
    if (flat[locale][key] === undefined && flat[locale][`${key}_other`] === undefined)
      onMissing?.(key, locale);
    return interpolate(resolved, params);
  };

  const toDate = (value: Date | number) => (value instanceof Date ? value : new Date(value));

  return {
    locale,
    formatLocale,
    useBengaliDigits,
    t,
    has: (key) =>
      key in flat[locale] ||
      `${key}_other` in flat[locale] ||
      key in flat.en ||
      `${key}_other` in flat.en,
    formatNumber: (value, opts) => numberFormat(opts).format(value),
    formatDate: (value, opts) =>
      new Intl.DateTimeFormat(formatLocale, {
        numberingSystem,
        dateStyle: 'medium',
        ...opts,
      }).format(toDate(value)),
    formatTime: (value, opts) =>
      new Intl.DateTimeFormat(formatLocale, {
        numberingSystem,
        timeStyle: 'short',
        ...opts,
      }).format(toDate(value)),
    formatRelativeTime: (value, now = Date.now()) => {
      const diffSeconds = Math.round((toDate(value).getTime() - now) / 1000);
      const abs = Math.abs(diffSeconds);
      const rtf = new Intl.RelativeTimeFormat(`${formatLocale}-u-nu-${numberingSystem}`, {
        numeric: 'auto',
      });
      if (abs < 45) return rtf.format(0, 'second');
      if (abs < 3600) return rtf.format(Math.round(diffSeconds / 60), 'minute');
      if (abs < 86_400) return rtf.format(Math.round(diffSeconds / 3600), 'hour');
      return rtf.format(Math.round(diffSeconds / 86_400), 'day');
    },
    formatDuration: (ms) => {
      const totalSeconds = Math.max(0, Math.round(ms / 1000));
      if (ms > 0 && totalSeconds === 0) return t('time.lessThanASecond');
      const days = Math.floor(totalSeconds / 86_400);
      const hours = Math.floor((totalSeconds % 86_400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const parts: string[] = [];
      if (days) parts.push(t('time.daysShort', { n: days }));
      if (hours) parts.push(t('time.hoursShort', { n: hours }));
      if (minutes) parts.push(t('time.minutesShort', { n: minutes }));
      if (seconds || parts.length === 0) parts.push(t('time.secondsShort', { n: seconds }));
      return parts.slice(0, 2).join(' ');
    },
    formatFileSize: (bytes) => {
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = Math.max(0, bytes);
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      const digits = unit === 0 || value >= 100 ? 0 : 1;
      return `${numberFormat({ maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
    },
  };
}
