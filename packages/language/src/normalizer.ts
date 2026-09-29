import { extractTimeExpressions, type ExtractedTime, type TimeContext } from './datetime';
import {
  APP_PHRASES,
  AUXILIARIES,
  BENGALI_SUFFIXES,
  CONJUNCTIONS,
  FILE_TYPE_PHRASES,
  FOLDER_PHRASES,
  LANGUAGE_PHRASES,
  LIGHT_VERBS,
  NOUN_PHRASES,
  PREPOSITION_PHRASES,
  QUANTIFIER_PHRASES,
  REFERENCE_PHRASES,
  STOPWORDS,
  STRONG_SEQUENCE,
  VERB_FORMS,
  WEB_PHRASES,
  matchKey,
  type FileTypeEntry,
  type KnownFolder,
  type NounCanon,
  type PhraseEntry,
  type Preposition,
  type Quantifier,
  type RefCanon,
  type VerbCanon,
} from './lexicon';
import { canonicalize, normalizeDigits, normalizePunctuation } from './script';

// ── Protected literals ───────────────────────────────────────────────────────
export type LiteralKind = 'quote' | 'url' | 'email' | 'path' | 'file';

export interface LiteralSpan {
  kind: LiteralKind;
  /** Exactly as the user wrote it (quotes stripped for `quote`). Never altered or translated. */
  value: string;
  start: number;
  end: number;
}

const FILE_EXTENSIONS =
  'pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar|7z|png|jpe?g|gif|webp|svg|mp[34]|mkv|mov|avi|wav|m4a|json|md|py|js|ts|tsx|html?|css|exe|msi|log|iso|psd|ai|blend|max|dwg';
const TLDS = 'com|org|net|io|dev|app|bd|co|edu|gov|info|me|tv|ai|xyz|store|online|site|news|blog';

const LITERAL_PATTERNS: Array<{ kind: LiteralKind; pattern: RegExp }> = [
  { kind: 'quote', pattern: /"([^"\n]{1,300})"/gu },
  { kind: 'quote', pattern: /(?<![\p{L}\p{N}])'([^'\n]{2,300})'(?![\p{L}\p{N}])/gu },
  { kind: 'url', pattern: /\bhttps?:\/\/[^\s"'<>]+/giu },
  { kind: 'url', pattern: /\bwww\.[^\s"'<>]+/giu },
  { kind: 'email', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu },
  { kind: 'path', pattern: /(?<![\p{L}\p{N}])[A-Za-z]:\\[^\s"'<>|?*]*/gu },
  { kind: 'path', pattern: /(?<![\p{L}\p{N}])~[\\/][^\s"'<>|?*]*/gu },
  { kind: 'path', pattern: /\\\\[^\s"'<>|?*]+/gu },
  {
    kind: 'url',
    pattern: new RegExp(
      `(?<![\\p{L}\\p{N}@./-])[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})(?:/[^\\s"'<>]*)?(?![\\p{L}\\p{N}])`,
      'giu',
    ),
  },
  {
    kind: 'file',
    pattern: new RegExp(
      `(?<![\\p{L}\\p{M}\\p{N}])[\\p{L}\\p{M}\\p{N}_\\-.()]+\\.(?:${FILE_EXTENSIONS})(?![\\p{L}\\p{M}\\p{N}])`,
      'giu',
    ),
  },
];

export function findLiterals(text: string): LiteralSpan[] {
  const found: LiteralSpan[] = [];
  for (const { kind, pattern } of LITERAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (found.some((f) => start < f.end && end > f.start)) continue; // earlier (more specific) kinds win
      found.push({ kind, value: kind === 'quote' ? match[1]! : match[0], start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

// ── Tokens ───────────────────────────────────────────────────────────────────
export type Token =
  | { kind: 'verb'; raw: string; verb: VerbCanon; bengaliOrder: boolean; bareLoan: boolean }
  | { kind: 'app'; raw: string; app: string }
  | { kind: 'web'; raw: string; site: string }
  | { kind: 'folder'; raw: string; folder: KnownFolder; role?: Preposition }
  | { kind: 'filetype'; raw: string; fileType: FileTypeEntry }
  | { kind: 'noun'; raw: string; noun: NounCanon; role?: Preposition }
  | { kind: 'ref'; raw: string; ref: RefCanon; role?: Preposition }
  | { kind: 'prep'; raw: string; prep: Preposition; postposition: boolean }
  | { kind: 'quant'; raw: string; quant: Quantifier }
  | { kind: 'conj'; raw: string; sequence: boolean }
  | { kind: 'lang'; raw: string; language: 'bn' | 'en' }
  | { kind: 'literal'; raw: string; literal: LiteralSpan; role?: Preposition }
  | { kind: 'time'; raw: string; time: ExtractedTime }
  | { kind: 'number'; raw: string; value: number }
  | { kind: 'word'; raw: string };

export interface NormalizedCommand {
  /** Input after Unicode/punctuation normalisation. */
  text: string;
  tokens: Token[];
  literals: LiteralSpan[];
  times: ExtractedTime[];
  /** Language-independent rendering, e.g. `open folder:Downloads`. Debug/telemetry only. */
  canonicalText: string;
}

const PLACEHOLDER = /^§([LT])(\d+)§$/;

/** Cuts leading/trailing punctuation off a raw token without touching §placeholders§. */
function peel(raw: string): string {
  if (PLACEHOLDER.test(raw)) return raw;
  return raw
    .replace(/^[\s,;:!?()"'“”‘’…[\]{}<>]+|[\s,;:!?()"'“”‘’…[\]{}<>]+$/g, '')
    .replace(/\.+$/g, '');
}

/**
 * Splits attached Bengali case/classifier suffixes:
 *   "folderটা" → folder + টা,   "Downloads-এ" → Downloads + এ,   "PDFগুলো" → PDF + গুলো
 * Returns the pieces in order; suffix pieces are later dropped as stopwords or read as postpositions.
 */
function splitAttachedSuffix(word: string): string[] {
  if (PLACEHOLDER.test(word)) return [word];
  const latin = /^([A-Za-z0-9._+#]+)[-‐]?([ঀ-৿]+)$/u.exec(word);
  if (latin && BENGALI_SUFFIXES.includes(latin[2]!.normalize('NFC'))) return [latin[1]!, latin[2]!];
  return [word];
}

type Lookup = { phrases: PhraseEntry<unknown>[]; make: (value: unknown, raw: string) => Token };

const LOOKUPS: Lookup[] = [
  { phrases: APP_PHRASES, make: (v, raw) => ({ kind: 'app', raw, app: v as string }) },
  { phrases: WEB_PHRASES, make: (v, raw) => ({ kind: 'web', raw, site: v as string }) },
  {
    phrases: FOLDER_PHRASES,
    make: (v, raw) => ({ kind: 'folder', raw, folder: v as KnownFolder }),
  },
  {
    phrases: FILE_TYPE_PHRASES,
    make: (v, raw) => ({ kind: 'filetype', raw, fileType: v as FileTypeEntry }),
  },
  { phrases: REFERENCE_PHRASES, make: (v, raw) => ({ kind: 'ref', raw, ref: v as RefCanon }) },
  { phrases: NOUN_PHRASES, make: (v, raw) => ({ kind: 'noun', raw, noun: v as NounCanon }) },
  {
    phrases: PREPOSITION_PHRASES,
    make: (v, raw) => ({
      kind: 'prep',
      raw,
      prep: v as Preposition,
      postposition: /[ঀ-৿]/.test(raw) || /^(theke|moddhe|modhye|jonno|jonne|soho|diye)$/i.test(raw),
    }),
  },
  {
    phrases: QUANTIFIER_PHRASES,
    make: (v, raw) => ({ kind: 'quant', raw, quant: v as Quantifier }),
  },
  {
    phrases: LANGUAGE_PHRASES,
    make: (v, raw) => ({ kind: 'lang', raw, language: v as 'bn' | 'en' }),
  },
];

const MAX_PHRASE = 5;

interface Match {
  length: number;
  token: Token | 'drop';
}

/** Longest phrase, across every category, that starts at `index`. */
function matchAt(keys: string[], raws: string[], index: number): Match | undefined {
  let best: Match | undefined;
  const consider = (length: number, token: Token | 'drop') => {
    if (!best || length > best.length) best = { length, token };
  };

  for (let len = Math.min(MAX_PHRASE, keys.length - index); len >= 1; len -= 1) {
    const slice = keys.slice(index, index + len);
    const rawText = raws.slice(index, index + len).join(' ');
    const joined = slice.join(' ');

    for (const form of VERB_FORMS) {
      if (form.tokens.length === len && form.tokens.every((t, i) => t === slice[i])) {
        consider(len, {
          kind: 'verb',
          raw: rawText,
          verb: form.canonical,
          bengaliOrder: form.bengaliOrder,
          bareLoan: form.bareLoan,
        });
        break;
      }
    }
    for (const lookup of LOOKUPS) {
      const hit = lookup.phrases.find(
        (p) => p.tokens.length === len && p.tokens.join(' ') === joined,
      );
      if (hit) consider(len, lookup.make(hit.value, rawText));
    }
    if (len === 1 || STOPWORDS.has(joined)) {
      if (STOPWORDS.has(joined)) consider(len, 'drop');
    }
    if (CONJUNCTIONS.has(joined))
      consider(len, { kind: 'conj', raw: rawText, sequence: STRONG_SEQUENCE.has(joined) });
    if (best && best.length === len) break; // first (longest) hit wins
  }
  return best;
}

/** Are we looking at a stem that carries a Bengali suffix we can strip to reach a known word? */
function stripKnownSuffix(
  word: string,
  known: (key: string) => boolean,
): [string, string] | undefined {
  const key = matchKey(word);
  for (const suffix of BENGALI_SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const stem = key.slice(0, -suffix.length);
      if (known(stem)) return [word.slice(0, word.length - suffix.length), suffix];
    }
  }
  return undefined;
}

const KNOWN_SINGLE_WORDS: Set<string> = new Set();
for (const lookup of LOOKUPS)
  for (const p of lookup.phrases) if (p.tokens.length === 1) KNOWN_SINGLE_WORDS.add(p.tokens[0]!);
for (const form of VERB_FORMS)
  if (form.tokens.length === 1) KNOWN_SINGLE_WORDS.add(form.tokens[0]!);

const LIGHT_VERB_KEYS: ReadonlySet<string> = new Set(LIGHT_VERBS.map(matchKey));
/** A detached locative "এ"/"te" ("Desktop এ") marks the entity before it as a location/destination. */
const LOCATIVE_MARKERS: ReadonlySet<string> = new Set(['এ', 'তে', 'e', 'te']);

function markLocative(tokens: Token[]): void {
  const last = tokens[tokens.length - 1];
  if (
    last &&
    (last.kind === 'folder' ||
      last.kind === 'noun' ||
      last.kind === 'ref' ||
      last.kind === 'literal') &&
    !last.role
  ) {
    tokens[tokens.length - 1] = { ...last, role: 'in' };
  }
}

const ROLE_BY_SUFFIX: Record<string, Preposition> = { এ: 'in', '\u09C7': 'in', তে: 'in', য়: 'in' };

export type NormalizeOptions = TimeContext;

/**
 * Turns a raw command (Bengali, Banglish, English or a mix) into language-independent tokens.
 * Order matters: literals and times are lifted out FIRST so that their contents are never re-interpreted
 * ("খুলে দিন" must not read "দিন" as a day; a quoted query must survive untouched).
 */
export function normalizeCommand(input: string, options: NormalizeOptions): NormalizedCommand {
  const text = canonicalize(normalizePunctuation(input));

  // 1. lift out literals
  const literals = findLiterals(text);
  let working = '';
  let cursor = 0;
  literals.forEach((literal, i) => {
    working += `${text.slice(cursor, literal.start)}§L${i}§`;
    cursor = literal.end;
  });
  working += text.slice(cursor);

  // 2. lift out date/time expressions
  const times = extractTimeExpressions(working, options);
  let withTimes = '';
  cursor = 0;
  times.forEach((time, i) => {
    withTimes += `${working.slice(cursor, time.start)}§T${i}§`;
    cursor = time.end;
  });
  withTimes += working.slice(cursor);

  // 3. split into words (+ attached Bengali suffixes)
  const rawWords: string[] = [];
  for (const piece of withTimes.split(/\s+/)) {
    const clean = peel(piece);
    if (!clean) continue;
    // "§L0§," style leftovers and glued placeholders
    for (const part of clean.split(/(§[LT]\d+§)/).filter(Boolean)) {
      for (const word of splitAttachedSuffix(part)) rawWords.push(word);
    }
  }
  const words = rawWords.map((w) => normalizeDigits(w));
  const keys = words.map(matchKey);

  // 4. lexical pass
  const tokens: Token[] = [];
  let i = 0;
  while (i < words.length) {
    const placeholder = PLACEHOLDER.exec(words[i]!);
    if (placeholder) {
      const index = Number(placeholder[2]);
      if (placeholder[1] === 'L')
        tokens.push({ kind: 'literal', raw: literals[index]!.value, literal: literals[index]! });
      else tokens.push({ kind: 'time', raw: times[index]!.text, time: times[index]! });
      i += 1;
      continue;
    }

    const match = matchAt(keys, words, i);

    // Unknown word carrying a Bengali suffix ("ক্রোমে", "ফাইলগুলো"): strip it and retry on the stem.
    if (!match || match.token === 'drop') {
      const stripped = !match
        ? stripKnownSuffix(words[i]!, (k) => KNOWN_SINGLE_WORDS.has(k))
        : undefined;
      if (stripped) {
        const [stem, suffix] = stripped;
        const stemMatch = matchAt([matchKey(stem)], [stem], 0);
        if (stemMatch && stemMatch.token !== 'drop') {
          const role = ROLE_BY_SUFFIX[suffix];
          const token = stemMatch.token;
          if (role && (token.kind === 'folder' || token.kind === 'noun' || token.kind === 'ref'))
            tokens.push({ ...token, role });
          else tokens.push(token);
          i += 1;
          continue;
        }
      }
    }

    if (match) {
      if (match.token !== 'drop') tokens.push(match.token);
      else if (LOCATIVE_MARKERS.has(keys[i]!)) markLocative(tokens);
      i += match.length;
      continue;
    }

    // Unmatched: leftover light verbs / auxiliaries are noise; numbers and words are kept.
    const key = keys[i]!;
    if (AUXILIARIES.has(key) || LIGHT_VERB_KEYS.has(key)) {
      // "Chrome open koro": a light verb after a bare loan verb makes the clause verb-final (Bengali order).
      const last = tokens[tokens.length - 1];
      if (last?.kind === 'verb' && last.bareLoan)
        tokens[tokens.length - 1] = { ...last, bareLoan: false, bengaliOrder: true };
      i += 1;
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(words[i]!))
      tokens.push({ kind: 'number', raw: words[i]!, value: Number(words[i]) });
    else tokens.push({ kind: 'word', raw: words[i]! });
    i += 1;
  }

  const folded = foldRedundantNouns(assignRoles(tokens));
  return { text, tokens: folded, literals, times, canonicalText: describeTokens(folded) };
}

/**
 * Attaches prepositions to the entity they govern. Bengali postpositions follow their noun
 * ("Downloads থেকে" = from Downloads); English prepositions precede it ("from Downloads").
 */
function assignRoles(tokens: Token[]): Token[] {
  const out = tokens.slice();
  const consumed = new Set<number>();
  const assignable = (
    t: Token | undefined,
  ): t is Extract<Token, { kind: 'folder' | 'noun' | 'ref' | 'literal' }> =>
    t !== undefined &&
    (t.kind === 'folder' || t.kind === 'noun' || t.kind === 'ref' || t.kind === 'literal');

  out.forEach((token, index) => {
    if (token.kind !== 'prep') return;
    const step = token.postposition ? -1 : 1;
    for (let j = index + step; j >= 0 && j < out.length; j += step) {
      const candidate = out[j];
      if (assignable(candidate)) {
        if (!candidate.role) {
          out[j] = { ...candidate, role: token.prep };
          consumed.add(index);
        }
        break;
      }
      if (candidate && candidate.kind !== 'quant') break;
    }
  });
  // A preposition that has been attached to its entity has done its job; unattached ones stay visible.
  return out.filter((_, index) => !consumed.has(index));
}

/** "Downloads folder" is one thing, not a folder token plus a generic folder noun. */
function foldRedundantNouns(tokens: Token[]): Token[] {
  return tokens.filter((token, index) => {
    if (token.kind !== 'noun' || token.noun !== 'folder') return true;
    const prev = tokens[index - 1];
    const next = tokens[index + 1];
    return !(prev?.kind === 'folder' || next?.kind === 'folder');
  });
}

export function describeTokens(tokens: Token[]): string {
  return tokens
    .map((t) => {
      switch (t.kind) {
        case 'verb':
          return t.verb;
        case 'app':
          return `app:${t.app}`;
        case 'web':
          return `site:${t.site}`;
        case 'folder':
          return `folder:${t.folder}${t.role ? `@${t.role}` : ''}`;
        case 'filetype':
          return `type:${t.fileType.canonical}`;
        case 'noun':
          return `${t.noun}${t.role ? `@${t.role}` : ''}`;
        case 'ref':
          return `${t.ref}${t.role ? `@${t.role}` : ''}`;
        case 'prep':
          return `(${t.prep})`;
        case 'quant':
          return t.quant;
        case 'conj':
          return t.sequence ? 'THEN' : 'AND';
        case 'lang':
          return `lang:${t.language}`;
        case 'literal':
          return `${t.literal.kind}:${t.literal.value}${t.role ? `@${t.role}` : ''}`;
        case 'time':
          return `time:${t.time.text}`;
        case 'number':
          return `#${t.value}`;
        case 'word':
          return t.raw;
      }
    })
    .join(' ');
}
