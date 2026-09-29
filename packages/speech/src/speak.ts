/**
 * Prepares a reply for text-to-speech. Reading Markdown aloud ("asterisk asterisk bold asterisk asterisk"),
 * URLs letter by letter, or a code block line by line is unusable, so the spoken form is a cleaned, chunked
 * version of the written one. The written reply is never altered.
 */
export interface SpeechPrepOptions {
  /** Spoken in place of a URL / code block. Must be in the reply's language. */
  linkWord: string;
  codeWord: string;
  /** Hard cap on what is read aloud; the rest is dropped. */
  maxChars?: number;
}

const EMOJI = new RegExp(
  '\\p{Extended_Pictographic}|[\\u{1F1E6}-\\u{1F1FF}]|\\u200D|\\uFE0F',
  'gu',
);

export function prepareSpeechText(markdown: string, options: SpeechPrepOptions): string {
  const max = options.maxChars ?? 1500;
  let text = markdown
    .replace(/```[\s\S]*?```/g, ` ${options.codeWord}. `) // fenced code
    .replace(/`([^`\n]+)`/g, '$1') // inline code keeps its words
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]*\)/g, '$1') // links → label
    .replace(/\bhttps?:\/\/[^\s)]+/gi, options.linkWord)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/^\s*\d+[.)]\s+/gm, '') // numbered lists
    .replace(/^\s*>\s?/gm, '') // quotes
    .replace(/(\*\*|__|\*|_|~~)/g, '') // emphasis
    .replace(/\|/g, ' ') // table pipes
    .replace(EMOJI, '');
  // Every line (heading, bullet, paragraph) becomes its own sentence so the voice pauses between them.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .map((line) => (/[.!?।:;,]$/u.test(line) ? line : `${line}.`))
    .join(' ')
    .replace(/\s+([.,;:!?।])/g, '$1')
    .replace(/([.!?।])\s*\.+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (Array.from(text).length > max) text = Array.from(text).slice(0, max).join('').trimEnd();
  return text;
}

/**
 * Splits text into sentence-sized chunks so speech can start after the first sentence instead of waiting for
 * the whole reply. Sentence ends: . ! ? and the Bengali danda । — never split inside a number like 3.5.
 */
export function chunkForSpeech(text: string, maxChunk = 280): string[] {
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const sentence of sentences) {
    if (Array.from(sentence).length > maxChunk) {
      push();
      // Very long sentence: break on spaces without splitting a word.
      let piece = '';
      for (const word of sentence.split(/\s+/)) {
        if (Array.from(`${piece} ${word}`).length > maxChunk) {
          if (piece) chunks.push(piece.trim());
          piece = word;
        } else piece = piece ? `${piece} ${word}` : word;
      }
      if (piece) chunks.push(piece.trim());
      continue;
    }
    if (Array.from(`${current} ${sentence}`).length > maxChunk) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return chunks;
}

const TERMINATORS = new Set(['.', '!', '?', '।']);

/** Sentence split that leaves decimal points alone ("3.5"). */
function splitSentences(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]!;
    if (!TERMINATORS.has(c)) continue;
    const decimal = c === '.' && /\d/.test(chars[i - 1] ?? '') && /\d/.test(chars[i + 1] ?? '');
    if (decimal) continue;
    let end = i + 1;
    while (end < chars.length && TERMINATORS.has(chars[end]!)) end += 1; // "?!" / "..."
    const sentence = chars.slice(start, end).join('').trim();
    if (sentence) out.push(sentence);
    start = end;
    i = end - 1;
  }
  const rest = chars.slice(start).join('').trim();
  if (rest) out.push(rest);
  return out;
}

/** Picks the best installed system voice for a language; `undefined` means "none installed". */
export interface VoiceInfo {
  voiceURI: string;
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
}

export function pickVoice(
  voices: readonly VoiceInfo[],
  language: 'bn' | 'en',
  preferredUri?: string,
): VoiceInfo | undefined {
  const matches = voices.filter(
    (v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === language,
  );
  if (preferredUri) {
    const chosen = matches.find((v) => v.voiceURI === preferredUri);
    if (chosen) return chosen;
  }
  // Prefer the regional variant for Bengali (bn-BD), then natural/online voices, then anything local.
  const rank = (v: VoiceInfo) =>
    (language === 'bn' && /bn[-_]bd/i.test(v.lang) ? 4 : 0) +
    (/natural|neural|online/i.test(v.name) ? 2 : 0) +
    (v.localService ? 1 : 0);
  return [...matches].sort((a, b) => rank(b) - rank(a))[0];
}
