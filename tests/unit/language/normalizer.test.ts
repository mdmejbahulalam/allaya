import { describe, expect, it } from 'vitest';
import { findLiterals, normalizeCommand } from '@allaya/language';

const ctx = { today: { year: 2026, month: 9, day: 29 } };
const canon = (text: string) => normalizeCommand(text, ctx).canonicalText;

describe('literal protection', () => {
  it('lifts out quoted text, URLs, emails, paths and file names untouched', () => {
    const kinds = (text: string) => findLiterals(text).map((l) => `${l.kind}:${l.value}`);
    expect(kinds('search "best laptop 2026" now')).toEqual(['quote:best laptop 2026']);
    expect(kinds('open https://example.com/a?b=1 please')).toEqual([
      'url:https://example.com/a?b=1',
    ]);
    expect(kinds('youtube.com খুলো')).toEqual(['url:youtube.com']);
    expect(kinds('mail me at a.b@site.org')).toEqual(['email:a.b@site.org']);
    expect(kinds('open D:\\Work\\notes')).toEqual(['path:D:\\Work\\notes']);
    expect(kinds('report_final.docx ডিলিট করো')).toEqual(['file:report_final.docx']);
    expect(kinds('আমার নথি.pdf খোলো')).toEqual(['file:নথি.pdf']);
  });

  it('never interprets the inside of a quote as words, dates or verbs', () => {
    // "খুলে দিন" inside quotes must not become an open verb or the word "দিন" (day).
    const result = normalizeCommand('search করো "খুলে দিন কাল"', ctx);
    expect(result.times).toEqual([]);
    expect(result.literals).toHaveLength(1);
    expect(result.canonicalText).toContain('quote:খুলে দিন কাল');
    expect(result.canonicalText).not.toMatch(/open/);
  });

  it('does not split a file name that contains a keyword', () => {
    expect(canon('open download.txt')).toBe('open file:download.txt');
  });
});

describe('the same request in different languages normalises to the same tokens', () => {
  const openDownloads = [
    'Downloads folder টা খুলে দাও',
    'ডাউনলোড ফোল্ডার খুলে দাও',
    'Open my Downloads folder',
    'amar Downloads folder ta open koro',
    'Downloads folder ta khule dao',
    'please open the Downloads folder',
    'ভাই Downloads ফোল্ডারটা একটু খুলে দাও',
  ];
  it.each(openDownloads)('%s', (text) => {
    const tokens = canon(text).split(' ').sort().join(' ');
    expect(tokens).toBe('folder:Downloads open');
  });

  const openChrome = [
    'Chrome open koro',
    'Chrome খুলে দাও',
    'ক্রোম খুলে দাও',
    'open Chrome',
    'launch Google Chrome',
    'ক্রোম ওপেন করো',
    'chrome ta khule dao',
  ];
  it.each(openChrome)('%s', (text) => {
    expect(canon(text).split(' ').sort().join(' ')).toBe('app:Chrome open');
  });

  it('keeps the non-lexical parts (quotes, files) exactly as written', () => {
    expect(canon('Google এ "কাল আবহাওয়া কেমন" search করো')).toBe(
      'site:Google quote:কাল আবহাওয়া কেমন search',
    );
    expect(canon('Documents এ Report Final.docx খুঁজে দাও')).toContain('file:Final.docx');
  });
});

describe('Bengali structure', () => {
  it('splits attached case/classifier suffixes', () => {
    expect(canon('folderটা খুলে দাও')).toBe('folder open');
    expect(canon('PDFগুলো খুঁজে দাও')).toBe('type:pdf find');
    expect(canon('Downloads-এ যাও').split(' ')).toContain('folder:Downloads@in');
  });

  it('reads a locative এ after an entity as location/destination', () => {
    expect(canon('Desktop এ copy করো')).toBe('folder:Desktop@in copy');
  });

  it('assigns Bengali postpositions backwards and English prepositions forwards', () => {
    expect(canon('Downloads থেকে সব PDF Desktop এ copy করো')).toBe(
      'folder:Downloads@from all type:pdf folder:Desktop@in copy',
    );
    expect(canon('copy all PDF files from Downloads to Desktop')).toBe(
      'copy all type:pdf file folder:Downloads@from folder:Desktop@to',
    );
  });

  it('treats bare "ডাউনলোড" as the Downloads folder but "ডাউনলোড করো" as the verb', () => {
    expect(canon('ডাউনলোড খুলে দাও')).toBe('folder:Downloads open');
    expect(canon('https://a.com/f.zip ডাউনলোড করো')).toBe('url:https://a.com/f.zip download');
  });

  it('marks a light verb after a bare loan verb as verb-final', () => {
    const result = normalizeCommand('Chrome open koro', ctx);
    const verb = result.tokens.find((t) => t.kind === 'verb');
    expect(verb).toMatchObject({ verb: 'open', bengaliOrder: true });
    const english = normalizeCommand('open Chrome', ctx).tokens.find((t) => t.kind === 'verb');
    expect(english).toMatchObject({ verb: 'open', bengaliOrder: false });
  });

  it('does not read the verb "দিন" as a day', () => {
    const result = normalizeCommand('Chrome খুলে দিন', ctx);
    expect(result.times).toEqual([]);
    expect(result.canonicalText).toBe('app:Chrome open');
  });

  it('extracts time expressions once, before word matching', () => {
    const result = normalizeCommand('কাল সকাল ৯টায় Chrome খুলে দাও', ctx);
    expect(result.times.map((t) => t.text)).toEqual(['কাল', 'সকাল ৯টায়']);
    expect(result.canonicalText).toContain('app:Chrome');
  });
});

describe('unknown words are kept, never dropped silently', () => {
  it('keeps a folder name the lexicon does not know', () => {
    expect(canon('Open the Reports folder')).toBe('open Reports folder');
  });
  it('keeps numbers', () => {
    expect(canon('মুছে দাও ৩ টি ফাইল')).toContain('#3');
  });
});
