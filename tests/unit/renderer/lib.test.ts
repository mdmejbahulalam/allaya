import { describe, expect, it } from 'vitest';
import { contrastRatio, deriveAccentTokens, hexToHsl, hslToHex } from '@renderer/lib/color';
import { normalizeForSearch, scoreMatch } from '@renderer/lib/search';
import { matchesShortcut } from '@renderer/lib/shortcuts';
import { tierForWidth } from '@renderer/lib/use-viewport';
import { comboFromEvent } from '../../../apps/desktop/renderer/src/features/settings/shortcut-recorder';

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('search scoring', () => {
  it('prefers prefix over word-start over substring, and requires every token', () => {
    const prefix = scoreMatch('down', ['Downloads']);
    const word = scoreMatch('files', ['Search files']);
    const sub = scoreMatch('load', ['Downloads']);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(0);
    expect(scoreMatch('open zzz', ['Open Downloads'])).toBe(0);
    expect(scoreMatch('open down', ['Open Downloads'])).toBeGreaterThan(0);
  });

  it('matches Bengali text regardless of Unicode composition and finds English keywords', () => {
    const composed = 'ফোল্ডার খুলুন';
    const decomposed = composed.normalize('NFD');
    expect(scoreMatch(decomposed, [composed])).toBeGreaterThan(0);
    expect(normalizeForSearch(decomposed)).toBe(normalizeForSearch(composed));
    expect(scoreMatch('settings', ['সেটিংস খুলুন', 'Open settings', 'সেটিংস'])).toBeGreaterThan(0);
    expect(scoreMatch('খুলুন', ['ফোল্ডার খুলুন'])).toBeGreaterThan(0); // word-start inside Bengali
  });

  it('an empty query matches everything', () => {
    expect(scoreMatch('   ', ['anything'])).toBeGreaterThan(0);
  });
});

describe('keyboard shortcuts', () => {
  it('matches modifiers exactly and case-insensitively', () => {
    expect(matchesShortcut(key('k', { ctrlKey: true }), 'Ctrl+K')).toBe(true);
    expect(matchesShortcut(key('K', { ctrlKey: true }), 'ctrl+k')).toBe(true);
    expect(matchesShortcut(key('k'), 'Ctrl+K')).toBe(false);
    expect(matchesShortcut(key('k', { ctrlKey: true, shiftKey: true }), 'Ctrl+K')).toBe(false);
    expect(matchesShortcut(key('V', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+V')).toBe(true);
    expect(
      matchesShortcut(key('Escape', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Esc'),
    ).toBe(true);
    expect(matchesShortcut(key('/', { ctrlKey: true }), 'Ctrl+/')).toBe(true);
    expect(matchesShortcut(key('a'), '')).toBe(false);
  });

  it('records only combos that cannot swallow ordinary typing', () => {
    const ev = (k: string, m: Partial<KeyboardEventInit> = {}) =>
      new KeyboardEvent('keydown', { key: k, ...m });
    expect(comboFromEvent(ev('a'))).toBeNull(); // bare letter
    expect(comboFromEvent(ev('Control', { ctrlKey: true }))).toBeNull(); // modifier alone
    expect(comboFromEvent(ev('k', { ctrlKey: true }))).toBe('Ctrl+K');
    expect(comboFromEvent(ev('v', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+V');
    expect(comboFromEvent(ev('F5'))).toBe('F5');
    expect(comboFromEvent(ev(' ', { altKey: true }))).toBe('Alt+Space');
  });
});

describe('viewport tiers', () => {
  it.each([
    [1920, 'xl'],
    [1600, 'xl'],
    [1599, 'lg'],
    [1440, 'lg'],
    [1280, 'lg'],
    [1279, 'md'],
    [1100, 'md'],
    [1099, 'sm'],
    [800, 'sm'],
  ] as const)('%ipx → %s', (width, tier) => expect(tierForWidth(width)).toBe(tier));
});

describe('accent derivation keeps custom accents accessible', () => {
  const accents = [
    '#7c5cff',
    '#00c2ff',
    '#22c55e',
    '#f59e0b',
    '#ec4899',
    '#ef4444',
    '#facc15',
    '#ffffff',
    '#000000',
    '#808080',
  ];
  it.each(accents)('%s yields AA-contrast solid and text tokens on both themes', (accent) => {
    for (const [theme, surface] of [
      ['dark', '#171b23'],
      ['light', '#ffffff'],
    ] as const) {
      const t = deriveAccentTokens(accent, theme, surface);
      expect(contrastRatio('#ffffff', t.solid), `white on solid (${theme})`).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(t.text, surface), `text on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('round-trips hex ↔ hsl', () => {
    for (const hex of ['#7c5cff', '#00c2ff', '#123456']) {
      const back = hslToHex(hexToHsl(hex));
      expect(contrastRatio(back, hex)).toBeLessThan(1.05); // visually identical
    }
  });
});
