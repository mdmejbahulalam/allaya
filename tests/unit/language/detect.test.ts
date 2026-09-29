import { describe, expect, it } from 'vitest';
import { LanguageSession, detectLanguage } from '@allaya/language';

describe('language detection', () => {
  const cases: Array<[string, string, 'bn' | 'en']> = [
    // Bengali script
    ['আমি ঠিক বুঝতে পারিনি।', 'bn', 'bn'],
    ['আমার Downloads folder খুলে দাও', 'mixed-bn-en', 'bn'],
    ['Downloads folder টা খুলে দাও', 'mixed-bn-en', 'bn'],
    ['Chrome চালু করো', 'mixed-bn-en', 'bn'],
    ['PDF ফাইলগুলো খুঁজে দাও', 'mixed-bn-en', 'bn'],
    ['গত ৭ দিনের ফাইলগুলো দেখাও', 'bn', 'bn'],
    ['স্ক্রিনশট নাও', 'bn', 'bn'],
    ['এটা বন্ধ করো', 'bn', 'bn'],
    ['বাংলায় কথা বলো', 'bn', 'bn'],
    // English
    ['Open my Downloads folder', 'en', 'en'],
    ['Take a screenshot', 'en', 'en'],
    ['Find the PDF files from the last 7 days', 'en', 'en'],
    ['Close Chrome', 'en', 'en'],
    ['Lock computer', 'en', 'en'],
    ['Speak English', 'en', 'en'],
    ['I sat down and read the tin can label', 'en', 'en'], // "sat"/"tin"/"can" must not read as Bengali
    // Banglish / romanised Bengali
    ['amar Downloads folder ta open koro', 'romanized-bn', 'bn'],
    ['Chrome ta bondho koro', 'romanized-bn', 'bn'],
    ['PDF file gula khuje dao', 'romanized-bn', 'bn'],
    ['screenshot nao', 'romanized-bn', 'bn'],
    ['ei folder ta muche dao', 'romanized-bn', 'bn'],
    ['gato 7 diner file gulo dekhao', 'romanized-bn', 'bn'],
    ['Chrome khule Google e search koro', 'romanized-bn', 'bn'],
    // Code-switching that stays English
    ['Send this to রহিম please', 'mixed-bn-en', 'en'],
  ];

  it.each(cases)('%s → %s (reply in %s)', (text, language, primary) => {
    const result = detectLanguage(text);
    expect(result.language).toBe(language);
    expect(result.primary).toBe(primary);
  });

  it('assigns locales: bn-BD for anything Bengali, en-GB for British spellings, else en-US', () => {
    expect(detectLanguage('আমার ফাইল').locale).toBe('bn-BD');
    expect(detectLanguage('amar file ta open koro').locale).toBe('bn-BD');
    expect(detectLanguage('Open my favourite colour palette').locale).toBe('en-GB');
    expect(detectLanguage('Open my favorite color palette').locale).toBe('en-US');
  });

  it('is confident on clear input and unsure on one-word or symbol-only input', () => {
    expect(detectLanguage('আমি আমার ফাইলগুলো খুঁজে দেখতে চাই').confidence).toBeGreaterThan(0.9);
    expect(detectLanguage('Please open my Downloads folder now').confidence).toBeGreaterThan(0.7);
    expect(detectLanguage('ok').confidence).toBeLessThan(0.55);
    expect(detectLanguage('xyz').confidence).toBeLessThan(0.55);
    expect(detectLanguage('12345 !!!').confidence).toBe(0);
    expect(detectLanguage('').confidence).toBe(0);
  });

  it('detection is independent of Unicode encoding of the same Bengali text', () => {
    const composed = 'ড়'; // U+09DC
    const decomposed = 'ড়';
    expect(detectLanguage(`আমার ${composed}`).language).toBe(
      detectLanguage(`আমার ${decomposed}`).language,
    );
  });
});

describe('LanguageSession: keeping replies in the user language', () => {
  const analyse = (text: string) => detectLanguage(text);

  it('an explicit request in the conversation beats the app-wide policy', () => {
    const session = new LanguageSession();
    session.setExplicit('en');
    expect(session.resolve('bn', analyse('আমার ফাইল খুঁজে দাও'), 'bn')).toEqual({
      language: 'en',
      reason: 'explicit',
    });
  });

  it('can be rebuilt from persisted state', () => {
    const restored = LanguageSession.restore({ explicit: null, last: 'bn' });
    expect(restored.resolve('auto', analyse('ok'), 'en')).toEqual({
      language: 'bn',
      reason: 'history',
    });
    expect(LanguageSession.restore({ explicit: 'en' }).explicitLanguage).toBe('en');
  });

  it('an explicit policy always wins', () => {
    const session = new LanguageSession();
    expect(session.resolve('bn', analyse('Open Chrome'), 'en')).toEqual({
      language: 'bn',
      reason: 'policy',
    });
    expect(session.resolve('mixed', analyse('Open Chrome'), 'en')).toEqual({
      language: 'mixed',
      reason: 'policy',
    });
  });

  it('auto follows the detected language turn by turn', () => {
    const session = new LanguageSession();
    expect(session.resolve('auto', analyse('আমার Downloads folder খুলে দাও'), 'en')).toEqual({
      language: 'bn',
      reason: 'detected',
    });
    expect(session.resolve('auto', analyse('Open my Downloads folder'), 'bn')).toEqual({
      language: 'en',
      reason: 'detected',
    });
    expect(session.resolve('auto', analyse('amar Downloads folder ta open koro'), 'en')).toEqual({
      language: 'bn',
      reason: 'detected',
    });
  });

  it('a spoken "speak English"/"বাংলায় বলো" request sticks until reset', () => {
    const session = new LanguageSession();
    session.setExplicit('en');
    expect(session.resolve('auto', analyse('আমার ফাইল খুঁজে দাও'), 'bn')).toEqual({
      language: 'en',
      reason: 'explicit',
    });
    session.setExplicit(null);
    expect(session.resolve('auto', analyse('আমার ফাইল খুঁজে দাও'), 'en').language).toBe('bn');
  });

  it('short ambiguous replies inherit the previous language instead of flipping', () => {
    const session = new LanguageSession();
    session.observe(analyse('আমার Downloads folder খুলে দাও'));
    expect(session.resolve('auto', analyse('ok'), 'en')).toEqual({
      language: 'bn',
      reason: 'history',
    });
    session.observe(analyse('Open my Downloads folder please'));
    expect(session.resolve('auto', analyse('ok'), 'bn')).toEqual({
      language: 'en',
      reason: 'history',
    });
  });

  it('with no evidence at all it falls back to the UI language', () => {
    expect(new LanguageSession().resolve('auto', analyse('ok'), 'bn')).toEqual({
      language: 'bn',
      reason: 'ui',
    });
  });

  it('a weak detection never overwrites established history', () => {
    const session = new LanguageSession();
    session.observe(analyse('আমি আমার ফাইলগুলো খুঁজে দেখতে চাই'));
    session.observe(analyse('ok'));
    expect(session.resolve('auto', analyse('yes'), 'en').language).toBe('bn');
  });
});
