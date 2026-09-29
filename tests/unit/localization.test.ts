import { describe, expect, it } from 'vitest';
import {
  catalogs,
  createTranslator,
  flattenCatalog,
  greetingPeriod,
  resolveUiLocale,
  toBengaliDigits,
  toLatinDigits,
} from '@allaya/localization';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('catalog integrity (no hard-coded or missing UI strings)', () => {
  const en = flattenCatalog(catalogs.en);
  const bn = flattenCatalog(catalogs.bn);

  it('bn and en define exactly the same keys', () => {
    const missingInBn = Object.keys(en).filter((k) => !(k in bn));
    const extraInBn = Object.keys(bn).filter((k) => !(k in en));
    expect({ missingInBn, extraInBn }).toEqual({ missingInBn: [], extraInBn: [] });
  });

  it('every message keeps the same {placeholders} in both languages', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(placeholders(bn[key]!), key).toEqual(placeholders(value));
    }
  });

  it('no message is empty', () => {
    for (const [key, value] of [...Object.entries(en), ...Object.entries(bn)]) {
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  it('Bengali messages actually contain Bengali script (except brand-only strings)', () => {
    const allowLatinOnly = new Set([
      'app.name',
      'chat.allaya',
      'activity.actors.allaya',
      'settings.language.en',
      'tasks.title',
      'nav.tasks',
      'memory.categories.tasks',
      'models.apiKey',
      'help.tip3',
      'chat.autonym.en',
    ]);
    for (const [key, value] of Object.entries(bn)) {
      if (allowLatinOnly.has(key) || key.startsWith('taskState.') || /^\{/.test(value)) continue;
      if (!/[ঀ-৿]/.test(value)) throw new Error(`${key} has no Bengali script: ${value}`);
    }
  });
});

describe('translator', () => {
  it('interpolates parameters', () => {
    const t = createTranslator({ locale: 'en' });
    expect(t.t('greeting.afternoon', { name: 'Babul' })).toBe('Good afternoon, Babul');
    const bn = createTranslator({ locale: 'bn' });
    expect(bn.t('greeting.afternoon', { name: 'Babul' })).toBe('শুভ অপরাহ্ন, Babul');
  });

  it('selects plural forms and formats counts with locale numerals', () => {
    const en = createTranslator({ locale: 'en' });
    expect(en.t('tasks.actions', { count: 1 })).toBe('1 action');
    expect(en.t('tasks.actions', { count: 12 })).toBe('12 actions');
    const bn = createTranslator({ locale: 'bn' });
    expect(bn.t('tasks.actions', { count: 12 })).toBe('১২টি অ্যাকশন');
  });

  it('honours the numeral preference independently of language', () => {
    expect(createTranslator({ locale: 'bn', numerals: 'latin' }).formatNumber(123)).toBe('123');
    expect(createTranslator({ locale: 'en', numerals: 'bengali' }).formatNumber(123)).toBe('১২৩');
    expect(createTranslator({ locale: 'en' }).formatNumber(1234.5)).toBe('1,234.5');
  });

  it('falls back to English for a missing key and reports it', () => {
    const missing: string[] = [];
    const t = createTranslator({ locale: 'bn', onMissing: (k) => missing.push(k) });
    expect(t.t('nonexistent.key' as never)).toBe('nonexistent.key');
    expect(missing).toEqual(['nonexistent.key']);
  });

  it('formats durations, sizes and relative times in Bengali', () => {
    const bn = createTranslator({ locale: 'bn' });
    expect(bn.formatDuration(150_000)).toBe('২ মি. ৩০ সে.');
    expect(bn.formatFileSize(1_572_864)).toBe('১.৫ MB');
    const now = Date.UTC(2026, 0, 1, 12);
    expect(bn.formatRelativeTime(now - 5 * 60_000, now)).toContain('৫');
    const en = createTranslator({ locale: 'en' });
    expect(en.formatDuration(150_000)).toBe('2m 30s');
    expect(en.formatDuration(200)).toBe('<1s');
  });

  it('resolves UI locale from preference and OS locale', () => {
    expect(resolveUiLocale('auto', 'bn-BD')).toBe('bn');
    expect(resolveUiLocale('auto', 'en-GB')).toBe('en');
    expect(resolveUiLocale('auto', 'de-DE')).toBe('en');
    expect(resolveUiLocale('bn', 'en-US')).toBe('bn');
  });

  it('converts digits both ways', () => {
    expect(toBengaliDigits('১২3 file 45')).toBe('১২৩ file ৪৫');
    expect(toLatinDigits('১২৩')).toBe('123');
  });

  it('picks the greeting period from the hour', () => {
    expect([4, 5, 11, 12, 16, 17, 20, 21, 23].map(greetingPeriod)).toEqual([
      'night',
      'morning',
      'morning',
      'afternoon',
      'afternoon',
      'evening',
      'evening',
      'night',
      'night',
    ]);
  });
});
