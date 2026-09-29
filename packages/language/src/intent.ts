import type { IntentType } from '@allaya/types';
import type { ExtractedTime } from './datetime';
import type { KnownFolder, Preposition, VerbCanon } from './lexicon';
import {
  normalizeCommand,
  type LiteralSpan,
  type NormalizeOptions,
  type NormalizedCommand,
  type Token,
} from './normalizer';

/**
 * Deterministic intent parsing.
 *
 * This is the *fast path* for short, unambiguous commands. It is deliberately conservative: whenever a clause
 * is not fully understood it says so (`resolved: false`) and the AI planner takes over. It never guesses a
 * destructive target, and it never fills a missing parameter — it reports it in `missing`.
 *
 * The output is language-independent: nothing downstream needs to know the command was Bengali.
 */
export interface IntentParams {
  app?: string;
  /** "Google", "YouTube": a search engine or website chosen by name. */
  site?: string;
  url?: string;
  query?: string;
  folder?: KnownFolder;
  path?: string;
  fileName?: string;
  fileTypes?: string[];
  extensions?: string[];
  /** "all PDFs" — applies to every match, so it is treated as a bulk operation downstream. */
  all?: boolean;
  fromFolder?: KnownFolder;
  fromPath?: string;
  toFolder?: KnownFolder;
  toPath?: string;
  newName?: string;
  /** Name for a folder/file being created. */
  name?: string;
  language?: 'bn' | 'en';
  target?: 'screen' | 'window' | 'browser';
  /** "this folder" — must be resolved from conversation context before use. */
  refersToContext?: boolean;
}

export interface ParsedIntent {
  type: IntentType;
  params: IntentParams;
  /** Parameters required for this intent that were not given. Never guessed. */
  missing: string[];
  /** Deletes and other data-loss operations. The risk engine (Phase 5) still decides on confirmation. */
  destructive: boolean;
  /** True when every meaningful word in the clause was accounted for. */
  resolved: boolean;
  /** Words the parser did not understand (kept so the planner/UI can show what was ignored). */
  leftovers: string[];
  /** The canonical verb that produced this intent. */
  verb?: VerbCanon;
  /** Set by context resolution: what was filled in from earlier conversation. */
  fromContext?: string[];
}

export interface ParsedCommand {
  normalized: NormalizedCommand;
  clauses: ParsedIntent[];
  /** Clauses are ordered steps ("Chrome খুলে তারপর …"), never parallel. */
  sequential: boolean;
  times: ExtractedTime[];
  /** True unless every clause is resolved and complete: hand the command to the AI planner. */
  needsPlanner: boolean;
}

const blank = (type: IntentType, verb?: VerbCanon): ParsedIntent => ({
  type,
  params: {},
  missing: [],
  destructive: false,
  resolved: true,
  leftovers: [],
  ...(verb ? { verb } : {}),
});

const UNKNOWN = (leftovers: string[], verb?: VerbCanon): ParsedIntent => ({
  ...blank('UNKNOWN', verb),
  resolved: false,
  leftovers,
});

/** What a clause contains, independent of order. */
interface Bag {
  verb: Extract<Token, { kind: 'verb' }> | undefined;
  apps: string[];
  sites: string[];
  folders: Array<{ folder: KnownFolder; role: Preposition | undefined }>;
  fileTypes: Array<{ canonical: string; extensions: string[]; raw: string }>;
  nouns: Array<{ noun: string; role: Preposition | undefined }>;
  refs: Array<{ ref: string; role: Preposition | undefined }>;
  quants: string[];
  literals: Array<{ literal: LiteralSpan; role: Preposition | undefined }>;
  langs: Array<'bn' | 'en'>;
  words: string[];
  numbers: number[];
}

function bagOf(tokens: Token[]): Bag {
  const bag: Bag = {
    verb: undefined,
    apps: [],
    sites: [],
    folders: [],
    fileTypes: [],
    nouns: [],
    refs: [],
    quants: [],
    literals: [],
    langs: [],
    words: [],
    numbers: [],
  };
  for (const t of tokens) {
    switch (t.kind) {
      case 'verb':
        bag.verb ??= t;
        break;
      case 'app':
        bag.apps.push(t.app);
        break;
      case 'web':
        bag.sites.push(t.site);
        break;
      case 'folder':
        bag.folders.push({ folder: t.folder, role: t.role });
        break;
      case 'filetype':
        bag.fileTypes.push({
          canonical: t.fileType.canonical,
          extensions: t.fileType.extensions,
          raw: t.raw,
        });
        break;
      case 'noun':
        bag.nouns.push({ noun: t.noun, role: t.role });
        break;
      case 'ref':
        bag.refs.push({ ref: t.ref, role: t.role });
        break;
      case 'quant':
        bag.quants.push(t.quant);
        break;
      case 'literal':
        bag.literals.push({ literal: t.literal, role: t.role });
        break;
      case 'lang':
        bag.langs.push(t.language);
        break;
      case 'word':
        bag.words.push(t.raw);
        break;
      case 'number':
        bag.numbers.push(t.value);
        break;
      case 'time':
      case 'prep':
      case 'conj':
        break;
    }
  }
  return bag;
}

const hasNoun = (bag: Bag, noun: string) => bag.nouns.some((n) => n.noun === noun);
const isDestination = (role: Preposition | undefined) => role === 'to' || role === 'in';

const extensionOf = (name: string): string | undefined =>
  /\.[A-Za-z0-9]{1,5}$/.exec(name)?.[0]?.toLowerCase();

function fileLiterals(bag: Bag) {
  return bag.literals.filter((l) => l.literal.kind === 'file');
}
function pathLiterals(bag: Bag) {
  return bag.literals.filter((l) => l.literal.kind === 'path');
}
function textLiterals(bag: Bag) {
  return bag.literals.filter((l) => l.literal.kind === 'quote');
}
function urlLiterals(bag: Bag) {
  return bag.literals.filter((l) => l.literal.kind === 'url');
}

/** File-type filters ("all PDFs"). */
function fileTypeParams(bag: Bag): Pick<IntentParams, 'fileTypes' | 'extensions'> {
  if (bag.fileTypes.length === 0) return {};
  return {
    fileTypes: [...new Set(bag.fileTypes.map((f) => f.canonical))],
    extensions: [...new Set(bag.fileTypes.flatMap((f) => f.extensions))],
  };
}

function finish(intent: ParsedIntent, bag: Bag, acceptsFreeText = false): ParsedIntent {
  if (!acceptsFreeText && bag.words.length > 0) {
    intent.resolved = false;
    intent.leftovers = [...bag.words];
  }
  if (intent.missing.length > 0) intent.resolved = false;
  return intent;
}

// ── Per-verb interpretation ──────────────────────────────────────────────────

function interpretOpen(bag: Bag, verb: VerbCanon): ParsedIntent {
  const urls = urlLiterals(bag);
  if (urls[0])
    return finish({ ...blank('OPEN_URL', verb), params: { url: urls[0].literal.value } }, bag);

  const files = fileLiterals(bag);
  if (files[0]) {
    const intent = {
      ...blank('OPEN_FILE', verb),
      params: { fileName: files[0].literal.value } as IntentParams,
    };
    const from = bag.folders[0];
    if (from) intent.params.folder = from.folder;
    return finish(intent, bag);
  }
  const paths = pathLiterals(bag);
  if (paths[0]) {
    const value = paths[0].literal.value;
    // "D:\Work\report.xlsx" is a file, "D:\Work" is a folder.
    return finish(
      { ...blank(extensionOf(value) ? 'OPEN_FILE' : 'OPEN_FOLDER', verb), params: { path: value } },
      bag,
    );
  }

  const folder = bag.folders.find((f) => f.role !== 'from') ?? bag.folders[0];
  if (folder)
    return finish({ ...blank('OPEN_FOLDER', verb), params: { folder: folder.folder } }, bag);

  if (bag.apps[0]) return finish({ ...blank('OPEN_APP', verb), params: { app: bag.apps[0] } }, bag);
  if (bag.sites[0])
    return finish({ ...blank('OPEN_URL', verb), params: { site: bag.sites[0] } }, bag);
  if (hasNoun(bag, 'settings')) return finish(blank('OPEN_SETTINGS', verb), bag);
  if (hasNoun(bag, 'browser'))
    return finish({ ...blank('OPEN_APP', verb), params: { target: 'browser' } }, bag);

  const thisFolder = hasNoun(bag, 'folder') && bag.refs.some((r) => r.ref === 'this');
  if (thisFolder)
    return finish({ ...blank('OPEN_FOLDER', verb), params: { refersToContext: true } }, bag);

  return finish({ ...blank('UNKNOWN', verb), missing: ['target'] }, bag);
}

function interpretClose(bag: Bag, verb: VerbCanon): ParsedIntent {
  if (bag.apps[0])
    return finish({ ...blank('CLOSE_APP', verb), params: { app: bag.apps[0] } }, bag);
  if (hasNoun(bag, 'window') || hasNoun(bag, 'tab') || bag.refs.some((r) => r.ref === 'this')) {
    return finish(
      { ...blank('CLOSE_APP', verb), params: { target: 'window', refersToContext: true } },
      bag,
    );
  }
  return finish({ ...blank('UNKNOWN', verb), missing: ['app'] }, bag);
}

function interpretFind(bag: Bag, verb: VerbCanon, searching: boolean): ParsedIntent {
  const inFolder =
    bag.folders.some((f) => f.role === 'in' || f.role === 'from') || pathLiterals(bag).length > 0;
  const fileish =
    hasNoun(bag, 'file') || hasNoun(bag, 'folder') || fileLiterals(bag).length > 0 || inFolder;
  const webish = bag.sites.length > 0 || hasNoun(bag, 'website') || hasNoun(bag, 'browser');

  // "search Google for X" / "গুগলে X সার্চ করো" — a web search unless files are clearly meant.
  if (searching && !fileish && (webish || textLiterals(bag)[0] || bag.words.length > 0)) {
    // "YouTube এ গান search করো": media words are the thing being searched for, not a file filter.
    const words = [...bag.words, ...bag.fileTypes.map((f) => f.raw)];
    const quote = textLiterals(bag)[0]?.literal.value;
    const query = quote ?? (words.length > 0 ? words.join(' ') : undefined);
    const intent = blank('WEB_SEARCH', verb);
    if (bag.sites[0]) intent.params.site = bag.sites[0];
    if (query) intent.params.query = query;
    else intent.missing.push('query');
    return finish(intent, { ...bag, words: [] }, true);
  }

  const intent = blank('FIND_FILES', verb);
  Object.assign(intent.params, fileTypeParams(bag));
  const named = fileLiterals(bag)[0]?.literal.value;
  if (named) {
    intent.params.fileName = named;
    const ext = extensionOf(named);
    if (ext) intent.params.extensions = [ext];
  }
  const quote = textLiterals(bag)[0]?.literal.value;
  if (quote) intent.params.query = quote;
  else if (!named && bag.words.length > 0) intent.params.query = bag.words.join(' ');
  const where = bag.folders.find((f) => f.role === 'in' || f.role === 'from') ?? bag.folders[0];
  if (where) intent.params.folder = where.folder;
  const path = pathLiterals(bag)[0];
  if (path) intent.params.path = path.literal.value;
  if (bag.quants.includes('all')) intent.params.all = true;

  const constrained = Boolean(
    intent.params.query ?? intent.params.fileName ?? intent.params.fileTypes,
  );
  if (!constrained) intent.missing.push('query');
  return finish(intent, bag, true);
}

function interpretShow(bag: Bag, verb: VerbCanon): ParsedIntent {
  const folder = bag.folders[0];
  if (hasNoun(bag, 'file') && folder) {
    return finish(
      {
        ...blank('LIST_DIRECTORY', verb),
        params: { folder: folder.folder, ...fileTypeParams(bag) },
      },
      bag,
    );
  }
  if (folder)
    return finish({ ...blank('OPEN_FOLDER', verb), params: { folder: folder.folder } }, bag);
  if (bag.apps[0])
    return finish({ ...blank('FOCUS_APP', verb), params: { app: bag.apps[0] } }, bag);
  if (hasNoun(bag, 'settings')) return finish(blank('OPEN_SETTINGS', verb), bag);
  return finish({ ...blank('UNKNOWN', verb), missing: ['target'] }, bag);
}

function interpretDelete(bag: Bag, verb: VerbCanon): ParsedIntent {
  const intent = { ...blank('DELETE_FILE', verb), destructive: true };
  const file = fileLiterals(bag)[0]?.literal.value;
  const path = pathLiterals(bag)[0]?.literal.value;
  const quote = textLiterals(bag)[0]?.literal.value;
  if (file) intent.params.fileName = file;
  else if (path) intent.params.path = path;
  else if (quote) intent.params.fileName = quote;
  Object.assign(intent.params, fileTypeParams(bag));
  const where = bag.folders.find((f) => f.role === 'from' || f.role === 'in') ?? bag.folders[0];
  if (where) intent.params.folder = where.folder;
  if (bag.quants.includes('all')) intent.params.all = true;
  if (bag.refs.some((r) => r.ref === 'this' || r.ref === 'that'))
    intent.params.refersToContext = true;

  // "delete this" is never a concrete target: what "this" is could be a file, a folder or a whole drive's worth of files.
  const hasTarget = Boolean(
    intent.params.fileName ?? intent.params.path ?? intent.params.fileTypes,
  );
  delete intent.params.refersToContext;
  // "delete Downloads" (a whole known folder) is never accepted from a bare noun: ask what exactly.
  if (!hasTarget) intent.missing.push('target');
  return finish(intent, bag);
}

/** The name that follows a "new folder"/"new file" request: quoted text wins, then a file literal, then loose words. */
function createdName(bag: Bag): string | undefined {
  return (
    textLiterals(bag)[0]?.literal.value ??
    fileLiterals(bag)[0]?.literal.value ??
    (bag.words.length > 0 ? bag.words.join(' ') : undefined)
  );
}

function interpretCreate(bag: Bag, verb: VerbCanon): ParsedIntent {
  const file = fileLiterals(bag)[0]?.literal.value;
  const wantsFolder = hasNoun(bag, 'folder') && !file;
  const parent = bag.folders.find((f) => f.role === 'in' || f.role === 'to') ?? bag.folders[0];
  const intent = blank(wantsFolder ? 'CREATE_FOLDER' : 'CREATE_FILE', verb);

  if (!wantsFolder && !file && !hasNoun(bag, 'file')) {
    return finish({ ...blank('UNKNOWN', verb), missing: ['target'] }, bag);
  }
  const name = createdName(bag);
  if (name) intent.params[wantsFolder ? 'name' : 'fileName'] = name;
  else intent.missing.push('name');
  if (parent) intent.params.folder = parent.folder;
  if (bag.refs.some((r) => r.ref === 'inside_this' || r.ref === 'this'))
    intent.params.refersToContext = true;
  const parentPath = pathLiterals(bag)[0]?.literal.value;
  if (parentPath) intent.params.path = parentPath;
  return finish(intent, { ...bag, words: [] }, true);
}

function interpretCopyMove(bag: Bag, verb: VerbCanon): ParsedIntent {
  const intent = blank(verb === 'copy' ? 'COPY_FILE' : 'MOVE_FILE', verb);
  const files = fileLiterals(bag);
  if (files[0]) intent.params.fileName = files[0].literal.value;
  Object.assign(intent.params, fileTypeParams(bag));
  if (bag.quants.includes('all')) intent.params.all = true;

  const paths = pathLiterals(bag);
  const from = bag.folders.find((f) => f.role === 'from');
  const fromPath = paths.find((p) => p.role === 'from');
  if (from) intent.params.fromFolder = from.folder;
  if (fromPath) intent.params.fromPath = fromPath.literal.value;

  const dest = bag.folders.find((f) => isDestination(f.role));
  const destPath = paths.find((p) => isDestination(p.role));
  if (dest) intent.params.toFolder = dest.folder;
  if (destPath) intent.params.toPath = destPath.literal.value;

  // Bare folders without roles: with a source given, the remaining one is the destination.
  const unroled = bag.folders.filter((f) => !f.role);
  if (!dest && !destPath && unroled.length === 1 && (from || fromPath || files[0]))
    intent.params.toFolder = unroled[0]!.folder;
  if (!from && !fromPath && unroled.length === 2 && !dest) {
    intent.params.fromFolder = unroled[0]!.folder;
    intent.params.toFolder = unroled[1]!.folder;
  }

  const hasSource = Boolean(
    intent.params.fileName ??
    intent.params.fileTypes ??
    intent.params.fromFolder ??
    intent.params.fromPath,
  );
  if (!hasSource) intent.missing.push('source');
  if (!intent.params.toFolder && !intent.params.toPath) intent.missing.push('destination');
  return finish(intent, bag);
}

function interpretRename(bag: Bag, verb: VerbCanon): ParsedIntent {
  const intent = blank('RENAME_FILE', verb);
  const files = fileLiterals(bag);
  const quotes = textLiterals(bag);
  if (files[0]) intent.params.fileName = files[0].literal.value;
  const target = files.find((f) => f.role === 'to') ?? files[1];
  if (target) intent.params.newName = target.literal.value;
  else if (quotes[0]) intent.params.newName = quotes[0].literal.value;
  if (bag.refs.some((r) => r.ref === 'this' || r.ref === 'that'))
    intent.params.refersToContext = true;
  if (!intent.params.fileName && !intent.params.refersToContext) intent.missing.push('source');
  if (!intent.params.newName) intent.missing.push('newName');
  return finish(intent, bag);
}

function interpretLanguage(bag: Bag): ParsedIntent | undefined {
  const language = bag.langs[0];
  if (!language) return undefined;
  return finish({ ...blank('SWITCH_LANGUAGE', 'speak'), params: { language } }, bag);
}

/** No subject at all besides the verb itself (references like "it" and politeness are fine). */
function standalone(bag: Bag): boolean {
  return (
    bag.apps.length +
      bag.sites.length +
      bag.folders.length +
      bag.fileTypes.length +
      bag.nouns.length +
      bag.literals.length +
      bag.langs.length +
      bag.words.length +
      bag.numbers.length ===
    0
  );
}

/** Interprets one clause: the tokens between conjunctions / after its verb. */
export function interpretClause(tokens: Token[]): ParsedIntent {
  const bag = bagOf(tokens);
  const verb = bag.verb;
  if (!verb) {
    // No verb: not actionable by itself, but the entities are kept (a correction like "না, Edge" needs them).
    const params: IntentParams = {};
    if (bag.apps[0]) params.app = bag.apps[0];
    if (bag.sites[0]) params.site = bag.sites[0];
    const folder = bag.folders[0];
    if (folder) params.folder = folder.folder;
    const file = fileLiterals(bag)[0];
    if (file) params.fileName = file.literal.value;
    return { ...UNKNOWN(bag.words), params };
  }

  switch (verb.verb) {
    case 'open':
    case 'go':
      if (verb.verb === 'go' && !urlLiterals(bag)[0] && !bag.sites[0])
        return { ...UNKNOWN(bag.words, verb.verb), missing: ['target'] };
      return interpretOpen(bag, verb.verb);
    case 'start':
      // "চালু করো" also means "turn on"; only a named app is unambiguous.
      return bag.apps[0] ? interpretOpen(bag, verb.verb) : UNKNOWN(bag.words, verb.verb);
    case 'close':
      return interpretClose(bag, verb.verb);
    case 'find':
      return interpretFind(bag, verb.verb, false);
    case 'search':
      return interpretFind(bag, verb.verb, true);
    case 'show':
      return interpretShow(bag, verb.verb);
    case 'delete':
      return interpretDelete(bag, verb.verb);
    case 'create':
      return interpretCreate(bag, verb.verb);
    case 'copy':
    case 'move':
      return interpretCopyMove(bag, verb.verb);
    case 'rename':
      return interpretRename(bag, verb.verb);
    case 'screenshot': {
      const target = hasNoun(bag, 'window') ? 'window' : 'screen';
      return finish({ ...blank('TAKE_SCREENSHOT', verb.verb), params: { target } }, bag);
    }
    // "stop" / "থামাও" only means "stop everything" when it is the whole command. "how do I stop Chrome from
    // starting up" or "stop the download" carry a subject and must not trigger an emergency-style halt.
    case 'stop':
      return standalone(bag) ? blank('STOP', verb.verb) : UNKNOWN(bag.words, verb.verb);
    case 'cancel':
      return standalone(bag) ? blank('CANCEL', verb.verb) : UNKNOWN(bag.words, verb.verb);
    case 'lock':
      return hasNoun(bag, 'computer') || hasNoun(bag, 'screen') || tokens.length === 1
        ? finish(blank('LOCK_COMPUTER', verb.verb), bag)
        : UNKNOWN(bag.words, verb.verb);
    case 'download': {
      const url = urlLiterals(bag)[0]?.literal.value;
      return url
        ? finish({ ...blank('DOWNLOAD_FILE', verb.verb), params: { url } }, bag)
        : { ...UNKNOWN(bag.words, verb.verb), missing: ['url'] };
    }
    case 'upload':
      return { ...UNKNOWN(bag.words, verb.verb), missing: ['target'] };
    case 'speak':
      return interpretLanguage(bag) ?? UNKNOWN(bag.words, verb.verb);
    case 'save':
      return UNKNOWN(bag.words, verb.verb);
  }
}

// ── Clause segmentation ──────────────────────────────────────────────────────

interface Segment {
  tokens: Token[];
  sequence: boolean;
}

/**
 * Splits a token stream into clauses.
 *  - explicit conjunctions ("and", "তারপর", "আর") always split;
 *  - Bengali is verb-final, so a Bengali-order verb ends its clause;
 *  - English is verb-initial, so an English-order verb starts a new clause if the current one already has a verb.
 */
export function segment(tokens: Token[]): Segment[] {
  const segments: Segment[] = [];
  let current: Token[] = [];
  let sequence = false;
  const flush = (nextSequence = false) => {
    if (current.some((t) => t.kind !== 'time')) segments.push({ tokens: current, sequence });
    current = [];
    sequence = nextSequence;
  };
  const hasVerb = () => current.some((t) => t.kind === 'verb');

  for (const token of tokens) {
    if (token.kind === 'conj') {
      flush(token.sequence);
      continue;
    }
    // "stop download" / "start run": a second verb straight after a bare verb is its object, not a new step.
    const hasArguments = current.some((t) => t.kind !== 'verb' && t.kind !== 'time');
    if (token.kind === 'verb' && !token.bengaliOrder && hasVerb() && hasArguments) flush(true);
    // A Bengali verb normally ends its clause. One that arrives first ("ওপেন করো Chrome") is verb-initial
    // speech/typing: the arguments follow it, so the clause stays open.
    const verbFirst =
      token.kind === 'verb' && token.bengaliOrder && !current.some((t) => t.kind !== 'time');
    current.push(token);
    if (token.kind === 'verb' && token.bengaliOrder && !verbFirst) flush(true);
  }
  flush();
  return segments;
}

/**
 * "Open Chrome and Edge" / "Downloads আর Desktop folder খুলে দাও": a clause with no verb of its own borrows the
 * verb of its neighbour (following clause for verb-final Bengali, preceding clause for English).
 */
function shareVerbs(segments: Segment[]): Segment[] {
  const verbOf = (s: Segment) =>
    s.tokens.find((t): t is Extract<Token, { kind: 'verb' }> => t.kind === 'verb');
  const out = segments.map((s) => ({ ...s, tokens: [...s.tokens] }));
  for (let i = 0; i < out.length; i += 1) {
    if (verbOf(out[i]!)) continue;
    const contentful = out[i]!.tokens.some((t) => t.kind !== 'time');
    if (!contentful) continue;
    const next = out[i + 1];
    const prev = out[i - 1];
    const nextVerb = next && verbOf(next);
    const prevVerb = prev && verbOf(prev);
    if (nextVerb?.bengaliOrder) out[i]!.tokens.push(nextVerb);
    else if (prevVerb && !prevVerb.bengaliOrder) out[i]!.tokens.unshift(prevVerb);
  }
  return out;
}

export function parseCommand(input: string, options: NormalizeOptions): ParsedCommand {
  const normalized = normalizeCommand(input, options);
  const segments = shareVerbs(segment(normalized.tokens));
  const clauses = segments.map((s) => interpretClause(s.tokens));
  const sequential = segments.length > 1;
  const understood = clauses.length > 0 && clauses.every((c) => c.type !== 'UNKNOWN' && c.resolved);
  return { normalized, clauses, sequential, times: normalized.times, needsPlanner: !understood };
}
