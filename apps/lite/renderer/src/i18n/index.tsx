import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { bn } from './bn';
import { en, type TextKey } from './en';

export type { TextKey };
export type Lang = 'en' | 'bn';
export type Params = Record<string, string | number>;

const DICTIONARIES: Record<Lang, Record<TextKey, string>> = { en, bn };

/** `auto` follows the computer's language: Bengali if it is Bengali, otherwise English. */
export function resolveLang(preference: 'auto' | Lang, osLocale: string): Lang {
  if (preference !== 'auto') return preference;
  return osLocale.toLowerCase().startsWith('bn') ? 'bn' : 'en';
}

export function translate(lang: Lang, key: TextKey, params?: Params): string {
  const text = DICTIONARIES[lang][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export interface Translator {
  lang: Lang;
  t: (key: TextKey, params?: Params) => string;
  /** True when a key exists, for keys built from a code (an error code, a reason). */
  has: (key: string) => key is TextKey;
}

const Context = createContext<Translator | null>(null);

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo<Translator>(
    () => ({
      lang,
      t: (key, params) => translate(lang, key, params),
      has: (key): key is TextKey => key in en,
    }),
    [lang],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useT(): Translator {
  const value = useContext(Context);
  if (!value) throw new Error('useT must be used inside <I18nProvider>');
  return value;
}
