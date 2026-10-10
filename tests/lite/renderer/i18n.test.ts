import { describe, expect, it } from 'vitest';
import { bn } from '@lite/renderer/src/i18n/bn';
import { en } from '@lite/renderer/src/i18n/en';
import { resolveLang, translate } from '@lite/renderer/src/i18n';

describe('the words on the screen', () => {
  it('Bengali has exactly the keys English has, and every Bengali text is in Bengali script', () => {
    expect(Object.keys(bn).sort()).toEqual(Object.keys(en).sort());
    // Words that are the same in both (a name, a number) are fine; sentences must be translated.
    for (const [key, text] of Object.entries(bn)) {
      const english = en[key as keyof typeof en];
      if (text === english) {
        // Only a name, or text that is all placeholders and punctuation, may read the same in both.
        expect(text.replace(/\{\w+\}/g, '').replace(/[\s:·,.\-–—]/g, ''), key).toMatch(
          /^(English|বাংলা|)$/,
        );
        continue;
      }
      expect(text, key).toMatch(/[ঀ-৿]/);
    }
  });

  it('the Bengali name of the assistant is আলেয়া, everywhere', () => {
    expect(bn['app.name']).toBe('আলেয়া');
    const all = Object.values(bn).join('\n');
    expect(all).not.toContain('আল্লায়া');
    expect(all).toContain('আলেয়া');
  });

  it('every placeholder in a text appears in its translation', () => {
    for (const [key, text] of Object.entries(en)) {
      const names = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
      const other = [...bn[key as keyof typeof bn].matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
      expect(other, key).toEqual(names);
    }
  });

  it('fills in values, and leaves an unknown placeholder visible', () => {
    expect(translate('en', 'nav.deleteChat', { title: 'Trip' })).toBe('Delete chat “Trip”');
    expect(translate('bn', 'providers.ok', { count: 3 })).toBe('সংযুক্ত · 3টি মডেল');
    expect(translate('en', 'nav.deleteChat')).toBe('Delete chat “{title}”');
  });

  it('follows the computer’s language unless one is chosen', () => {
    expect(resolveLang('auto', 'bn-BD')).toBe('bn');
    expect(resolveLang('auto', 'en-US')).toBe('en');
    expect(resolveLang('auto', 'fr-FR')).toBe('en');
    expect(resolveLang('en', 'bn-BD')).toBe('en');
    expect(resolveLang('bn', 'en-US')).toBe('bn');
  });
});
