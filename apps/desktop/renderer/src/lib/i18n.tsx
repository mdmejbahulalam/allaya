import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  createTranslator,
  greetingPeriod,
  resolveUiLocale,
  type Translator,
} from '@allaya/localization';
import { useSettingsStore } from '@renderer/stores/settings';
import { useAppInfoStore } from '@renderer/stores/app-info';

const I18nContext = createContext<Translator | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useSettingsStore((s) => s.values['language.ui']);
  const numerals = useSettingsStore((s) => s.values['language.numerals']);
  const osLocale = useAppInfoStore((s) => s.osLocale);

  const translator = useMemo(
    () =>
      createTranslator({
        locale: resolveUiLocale(language, osLocale),
        numerals,
      }),
    [language, numerals, osLocale],
  );
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useT(): Translator {
  const translator = useContext(I18nContext);
  if (!translator) throw new Error('useT must be used inside <I18nProvider>');
  return translator;
}

/** "Good afternoon, Babul" — period comes from the local clock, name from the profile setting. */
export function useGreeting(now: Date = new Date()): string {
  const translator = useT();
  const name = useSettingsStore((s) => s.values['profile.displayName']).trim();
  const period = greetingPeriod(now.getHours());
  return name
    ? translator.t(`greeting.${period}`, { name })
    : translator.t(`greeting.${period}Anon`);
}
