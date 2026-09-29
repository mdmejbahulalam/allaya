import { describe, expect, it } from 'vitest';
import {
  bengaliNumberValue,
  canonicalize,
  countScripts,
  hasBengali,
  normalizeDigits,
  normalizePunctuation,
  replaceNumberWords,
  tokenize,
} from '@allaya/language';

describe('script utilities', () => {
  it('converts Bengali digits and leaves the rest', () => {
    expect(normalizeDigits('১২৩৪৫৬৭৮৯০')).toBe('1234567890');
    expect(normalizeDigits('গত ৭ দিন, 12 files')).toBe('গত 7 দিন, 12 files');
  });

  it('NFC-normalises so differently-encoded য় compare equal, and drops zero-width joiners', () => {
    const precomposed = 'ড়'; // U+09DC
    const decomposed = 'ড়'; // ড + nukta
    expect(canonicalize(precomposed)).toBe(canonicalize(decomposed));
    expect(canonicalize('ক্\u200Dষ')).toBe(canonicalize('ক্ষ'));
    expect(canonicalize('  a   b \n c ')).toBe('a b c');
  });

  it('normalises Bengali punctuation (danda, curly quotes)', () => {
    expect(normalizePunctuation('খুলে দাও।')).toBe('খুলে দাও.');
    expect(normalizePunctuation('“best 3D” search করো')).toBe('"best 3D" search করো');
  });

  it('counts letters per script', () => {
    expect(countScripts('Chrome খুলে দাও ৩')).toMatchObject({ latin: 6, digits: 1 });
    expect(countScripts('Chrome খুলে দাও').bengali).toBeGreaterThan(5);
    expect(hasBengali('hello')).toBe(false);
    expect(hasBengali('hello বাংলা')).toBe(true);
  });

  it('tokenizes mixed text keeping file names, paths and hyphenated terms whole', () => {
    expect(tokenize('report.pdf খুলে দাও').map((t) => t.text)).toEqual([
      'report.pdf',
      'খুলে',
      'দাও',
    ]);
    expect(tokenize('Downloads-এ যাও').map((t) => t.text)).toEqual(['Downloads-এ', 'যাও']);
    expect(tokenize('C:\\Users\\Babul\\file.txt').map((t) => t.text)).toEqual([
      'C:\\Users\\Babul\\file.txt',
    ]);
  });
});

describe('Bengali number words', () => {
  it.each([
    ['এক', 1],
    ['দুই', 2],
    ['তিন', 3],
    ['চার', 4],
    ['পাঁচ', 5],
    ['ছয়', 6],
    ['সাত', 7],
    ['আট', 8],
    ['নয়', 9],
    ['দশ', 10],
    ['এগারো', 11],
    ['বারো', 12],
    ['তেরো', 13],
    ['চৌদ্দ', 14],
    ['পনেরো', 15],
    ['ষোলো', 16],
    ['সতেরো', 17],
    ['আঠারো', 18],
    ['উনিশ', 19],
    ['বিশ', 20],
    ['একুশ', 21],
    ['পঁচিশ', 25],
    ['ত্রিশ', 30],
    ['পঁয়ত্রিশ', 35],
    ['চল্লিশ', 40],
    ['পঞ্চাশ', 50],
    ['ষাট', 60],
    ['সত্তর', 70],
    ['আশি', 80],
    ['নব্বই', 90],
    ['নিরানব্বই', 99],
    ['একশো', 100],
    ['একশ', 100],
  ])('%s = %i', (word, value) => expect(bengaliNumberValue(word)).toBe(value));

  it('understands numeral classifiers and digits', () => {
    expect(bengaliNumberValue('তিনটা')).toBe(3);
    expect(bengaliNumberValue('পাঁচটি')).toBe(5);
    expect(bengaliNumberValue('৭টা')).toBe(7);
    expect(bengaliNumberValue('১২')).toBe(12);
    expect(bengaliNumberValue('12')).toBe(12);
    expect(bengaliNumberValue('ফাইল')).toBeUndefined();
    expect(bengaliNumberValue('')).toBeUndefined();
  });

  it('replaces number words and digits inside a sentence, leaving other words', () => {
    expect(replaceNumberWords('গত সাত দিনের ফাইল')).toBe('গত 7 দিনের ফাইল');
    expect(replaceNumberWords('গত ৭ দিন')).toBe('গত 7 দিন');
    expect(replaceNumberWords('সাড়ে পাঁচটা')).toBe('সাড়ে 5টা');
    expect(replaceNumberWords('open the file')).toBe('open the file');
  });
});
