import { useEffect, useState } from 'react';
import { resolveUiLocale } from '@allaya/localization';
import { deriveAccentTokens } from '@renderer/lib/color';
import { useAppInfoStore } from '@renderer/stores/app-info';
import { useSettingsStore } from '@renderer/stores/settings';

const DEFAULT_ACCENT = '#7c5cff';
const BENGALI_OPTICAL_SCALE = 1.06;
const SURFACE = { dark: '#171b23', light: '#ffffff' } as const;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Applies persisted appearance/language settings to the document root. */
export function useThemeEffects(): void {
  const values = useSettingsStore((s) => s.values);
  const osLocale = useAppInfoStore((s) => s.osLocale);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const systemReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const theme =
    values['appearance.theme'] === 'system'
      ? systemDark
        ? 'dark'
        : 'light'
      : values['appearance.theme'];
  const accent = values['appearance.accent'].toLowerCase();
  const motion =
    values['appearance.animations'] === 'system'
      ? systemReducedMotion
        ? 'reduced'
        : 'full'
      : values['appearance.animations'];
  const locale = resolveUiLocale(values['language.ui'], osLocale);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset['theme'] = theme;
    root.dataset['density'] = values['appearance.density'];
    root.dataset['glass'] = values['appearance.glass'] ? 'on' : 'off';
    root.dataset['motion'] = motion;
    root.lang = locale;
    // Noto Sans Bengali has a smaller x-height than Inter; a small bump keeps the two optically matched.
    root.style.fontSize = `${16 * values['appearance.uiScale'] * (locale === 'bn' ? BENGALI_OPTICAL_SCALE : 1)}px`;
  }, [theme, motion, locale, values]);

  useEffect(() => {
    const root = document.documentElement;
    const props = ['--accent', '--accent-solid', '--accent-text'] as const;
    if (accent === DEFAULT_ACCENT) {
      props.forEach((p) => root.style.removeProperty(p));
      return;
    }
    const tokens = deriveAccentTokens(accent, theme, SURFACE[theme]);
    root.style.setProperty('--accent', tokens.accent);
    root.style.setProperty('--accent-solid', tokens.solid);
    root.style.setProperty('--accent-text', tokens.text);
  }, [accent, theme]);
}

export function useMotionPreference(): 'always' | 'never' | 'user' {
  const animations = useSettingsStore((s) => s.values['appearance.animations']);
  return animations === 'reduced' ? 'always' : animations === 'full' ? 'never' : 'user';
}
