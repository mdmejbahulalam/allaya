import { describe, expect, it } from 'vitest';
import { REPLIES, reply, toBengaliDigits, type ReplyKey } from '@allaya/language';
import { hasBengali } from '@allaya/language';

const keys = Object.keys(REPLIES) as ReplyKey[];

describe('localized replies', () => {
  it.each(keys)('%s exists in both Bengali and English', (key) => {
    for (const count of [1, 2, 12]) {
      const bn = reply(key, 'bn', count);
      const en = reply(key, 'en', count);
      expect(bn.trim(), `${key}/bn`).not.toBe('');
      expect(en.trim(), `${key}/en`).not.toBe('');
      expect(hasBengali(bn), `${key}/bn is Bengali`).toBe(true);
      expect(hasBengali(en), `${key}/en is English`).toBe(false);
    }
  });

  it('uses Bengali digits in Bengali counts and Latin digits in English', () => {
    expect(reply('stopped', 'bn', 3)).toBe('৩টি কাজ থামিয়ে দিয়েছি।');
    expect(reply('stopped', 'en', 3)).toBe('Stopped 3 tasks.');
    expect(reply('stopped', 'bn', 1)).toBe('থামিয়ে দিয়েছি।');
    expect(reply('stopped', 'en', 1)).toBe('Stopped.');
  });

  it('converts digits', () => {
    expect(toBengaliDigits(2026)).toBe('২০২৬');
    expect(toBengaliDigits('a1b2')).toBe('a১b২');
  });
});
