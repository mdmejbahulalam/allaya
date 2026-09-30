import { describe, expect, it } from 'vitest';
import {
  AUDIO_TAG_GROUPS,
  EXPRESSIVE_VOICES,
  MAX_TAGS_PER_TEXT,
  cleanAudioTags,
  findAudioTags,
  stripAudioTags,
  stripAudioTagsOutsideCode,
  withLeadingTag,
} from '@allaya/speech';

describe('stripAudioTags (for a voice that would read them aloud)', () => {
  it('removes tags and the gap they leave', () => {
    expect(stripAudioTags('[excited] We did it! [laughs] Really.')).toBe('We did it! Really.');
    expect(stripAudioTags('Come here [whispers] , quietly.')).toBe('Come here, quietly.');
  });
  it('removes tags with spaces, commas and hyphens, in any case', () => {
    expect(stripAudioTags('[Short Pause]Okay [very, very-soft]fine')).toBe('Okay fine');
  });
  it('keeps link labels, numbers and things that are not tags', () => {
    expect(stripAudioTags('See [the docs](https://a.example/x) now')).toBe(
      'See [the docs](https://a.example/x) now',
    );
    expect(stripAudioTags('item [1] and [2024-05] and []')).toBe('item [1] and [2024-05] and []');
  });
  it('leaves Bengali text alone', () => {
    expect(stripAudioTags('[warm] নমস্কার, আমি আল্লায়া।')).toBe('নমস্কার, আমি আল্লায়া।');
  });
});

describe('cleanAudioTags (what reaches the expressive voice)', () => {
  it('lower-cases and tidies tags', () => {
    expect(cleanAudioTags('[Excited]  Hi   [SHORT   PAUSE] there')).toBe(
      '[excited] Hi [short pause] there',
    );
  });
  it('drops the same tag repeated back to back, not a tag that returns later', () => {
    expect(cleanAudioTags('[calm][calm] a [sad] b [calm] c')).toBe('[calm] a [sad] b [calm] c');
  });
  it('a flood of tags is cut at the limit', () => {
    const flood = Array.from(
      { length: 40 },
      (_, i) => `[t${'a'.repeat(1 + (i % 2))}${i % 5 ? 'b' : 'c'}] w`,
    ).join(' ');
    expect(findAudioTags(cleanAudioTags(flood)).length).toBeLessThanOrEqual(MAX_TAGS_PER_TEXT);
  });
  it('leaves link labels and code-like brackets alone', () => {
    expect(cleanAudioTags('[a link](https://x.example) and [7]')).toBe(
      '[a link](https://x.example) and [7]',
    );
  });
});

describe('the written reply', () => {
  it('hides tags in prose but never inside code', () => {
    const text = '[warm] Use `items[index]` here:\n```\nlet a = [note];\n```\n[softly] Done.';
    expect(stripAudioTagsOutsideCode(text)).toBe(
      'Use `items[index]` here:\n```\nlet a = [note];\n```\nDone.',
    );
  });
  it('holds back a tag that has begun but not ended while the reply is still arriving', () => {
    expect(stripAudioTagsOutsideCode('Great news [exci', true)).toBe('Great news');
    expect(stripAudioTagsOutsideCode('Great news [exci', false)).toBe('Great news [exci');
    expect(stripAudioTagsOutsideCode('Values are [1, 2', true)).toBe('Values are [1, 2');
  });
});

describe('the palette', () => {
  it('finds tags in order', () => {
    expect(findAudioTags('[Excited] a [whispers] b')).toEqual(['excited', 'whispers']);
  });
  it('puts a tag in front, only with safe characters', () => {
    expect(withLeadingTag('Hello', 'whispers')).toBe('[whispers] Hello');
    expect(withLeadingTag('Hello', '<x>]')).toBe('[x] Hello');
    expect(withLeadingTag('Hello', '123')).toBe('Hello');
  });
  it('every suggested tag is itself a well-formed tag, once', () => {
    const all = AUDIO_TAG_GROUPS.flatMap((g) => g.tags);
    expect(new Set(all).size).toBe(all.length);
    for (const tag of all) expect(findAudioTags(`[${tag}]`)).toEqual([tag]);
  });
  it('offers thirty distinct voices, each with a character', () => {
    expect(EXPRESSIVE_VOICES).toHaveLength(30);
    expect(new Set(EXPRESSIVE_VOICES.map((v) => v.name)).size).toBe(30);
    for (const v of EXPRESSIVE_VOICES) expect(v.tone).toMatch(/^[a-z]+$/);
  });
});
