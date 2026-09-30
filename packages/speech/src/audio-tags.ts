/**
 * Audio tags steer how an expressive voice delivers a line: `[whispers] Come closer.`, `Great news! [excited]`.
 * They are text in square brackets, so three things need care:
 *  - a voice that does not understand them must never read them aloud (`stripAudioTags`);
 *  - what reaches a voice that does is well-formed and bounded (`cleanAudioTags`) — a model cannot flood it;
 *  - the tag list the person sees is only a set of suggestions; any short lowercase phrase may be typed.
 */

/** A tag is a short phrase of letters, spaces, commas, hyphens or apostrophes. Not a link label, not a number. */
const TAG = /\[([A-Za-z][A-Za-z ,'-]{0,39})\]/g;
/** A Markdown link label: `[label](https://…)`. Never a tag. */
const LINK_LABEL = /\[[^\]]*\]\((?:https?:\/\/|mailto:)[^)]*\)/g;

export const MAX_TAGS_PER_TEXT = 12;

export interface AudioTagGroup {
  id: 'emotion' | 'delivery' | 'pace' | 'sound';
  tags: readonly string[];
}

/** Suggestions for the tag palette. The voice model understands many more; this is where a person starts. */
export const AUDIO_TAG_GROUPS: readonly AudioTagGroup[] = [
  {
    id: 'emotion',
    tags: [
      'excited',
      'happy',
      'warm',
      'calm',
      'curious',
      'serious',
      'sad',
      'surprised',
      'sarcastic',
      'annoyed',
    ],
  },
  { id: 'delivery', tags: ['whispers', 'softly', 'shouts', 'cheerfully', 'gently', 'confidently'] },
  { id: 'pace', tags: ['slowly', 'quickly', 'short pause', 'long pause'] },
  { id: 'sound', tags: ['laughs', 'giggles', 'sighs', 'gasps', 'clears throat'] },
];

/** Removes tags (and the space they leave) so a voice without tag support reads only the words. */
export function stripAudioTags(text: string, trim = true): string {
  const links: string[] = [];
  const guarded = text.replace(LINK_LABEL, (m) => `\uE000${links.push(m) - 1}\uE000`);
  const stripped = guarded
    // A tag that opens a line takes the space after it too, so the line starts with its first word.
    .replace(new RegExp(`^([ \\t]*)${TAG.source}[ \\t]*`, 'gm'), '$1')
    .replace(TAG, '')
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => links[Number(i)]!)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?।])/g, '$1');
  return trim ? stripped.trim() : stripped;
}

/**
 * Keeps well-formed tags (lower-cased, spaces collapsed), drops repeats of the same tag in a row and anything past
 * `MAX_TAGS_PER_TEXT`, and leaves link labels alone.
 */
export function cleanAudioTags(text: string): string {
  let count = 0;
  let previous = '';
  const links: string[] = [];
  const guarded = text.replace(LINK_LABEL, (m) => `\uE000${links.push(m) - 1}\uE000`);
  return guarded
    .replace(TAG, (_, raw: string) => {
      const tag = raw.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!tag || tag === previous || count >= MAX_TAGS_PER_TEXT) return '';
      previous = tag;
      count += 1;
      return `[${tag}]`;
    })
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => links[Number(i)]!)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** The tags present in a text, in order. */
export function findAudioTags(text: string): string[] {
  const out: string[] = [];
  for (const match of text.replace(LINK_LABEL, '').matchAll(TAG)) out.push(match[1]!.toLowerCase());
  return out;
}

/** Puts a tag in front of the text (what the palette does when the person has nothing selected). */
export function withLeadingTag(text: string, tag: string): string {
  const clean = tag.replace(/[^A-Za-z ,'-]/g, '').trim();
  return clean ? `[${clean}] ${text}`.trim() : text;
}

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g;

/**
 * For the written reply: takes tags out of the prose but never out of code (`items[index]` is not a tag). While a
 * reply is still arriving, a tag that has begun but not ended (`[whis`) is held back so it never flashes on screen.
 */
export function stripAudioTagsOutsideCode(text: string, streaming = false): string {
  const parts = text.split(CODE);
  const last = parts.length - 1;
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part; // code, exactly as written
    let prose = stripAudioTags(part, false);
    if (i === 0) prose = prose.trimStart();
    if (i === last) prose = prose.trimEnd();
    return prose;
  });
  const joined = out.join('');
  return streaming ? joined.replace(/\s?\[[A-Za-z ,'-]{0,39}$/, '') : joined;
}
