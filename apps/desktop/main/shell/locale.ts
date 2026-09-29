import type { LanguagePreference } from '@allaya/types';

/** Which of Allaya's two interface languages the shell (tray, notifications) speaks: the setting, else the system's. */
export function uiLocale(preference: LanguagePreference, osLocale: string): 'bn' | 'en' {
  if (preference === 'bn' || preference === 'en') return preference;
  return osLocale.toLowerCase().startsWith('bn') ? 'bn' : 'en';
}
