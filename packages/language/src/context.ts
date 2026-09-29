import type { NormalizeOptions } from './normalizer';
import { parseCommand, type IntentParams, type ParsedCommand, type ParsedIntent } from './intent';
import { CORRECTION_MARKERS, matchKey } from './lexicon';
import type { KnownFolder } from './lexicon';
import { canonicalize } from './script';

/**
 * What the conversation is currently "about". Lets Allaya resolve "এই folder এর মধ্যে" / "inside it" / "close that"
 * from an earlier turn. It only ever fills references the user actually made — never a missing target on its own.
 */
export interface ConversationContext {
  folder?: { folder?: KnownFolder; path?: string };
  app?: string;
  lastIntent?: ParsedIntent;
}

/** Updates the context from an executed/understood intent. */
export function updateContext(
  context: ConversationContext,
  intent: ParsedIntent,
): ConversationContext {
  const next: ConversationContext = { ...context, lastIntent: intent };
  const { params } = intent;
  if (
    intent.type === 'OPEN_FOLDER' ||
    intent.type === 'LIST_DIRECTORY' ||
    intent.type === 'FIND_FILES'
  ) {
    if (params.folder ?? params.path)
      next.folder = {
        ...(params.folder ? { folder: params.folder } : {}),
        ...(params.path ? { path: params.path } : {}),
      };
  }
  if (intent.type === 'CREATE_FOLDER' && params.name) {
    // The new folder becomes the natural subject of "open it" — but only its name is known here.
  }
  if ((intent.type === 'OPEN_APP' || intent.type === 'FOCUS_APP') && params.app)
    next.app = params.app;
  return next;
}

/**
 * Fills "this/that/inside it" references from context. Anything that cannot be resolved stays in `missing`
 * so the caller asks the user instead of guessing.
 */
export function resolveReferences(
  intent: ParsedIntent,
  context: ConversationContext,
): ParsedIntent {
  if (!intent.params.refersToContext) return intent;
  const params: IntentParams = { ...intent.params };
  const filled: string[] = [];
  let missing = [...intent.missing];

  // Only actions that *place* something in a folder may borrow it. Deletes and renames never take their target from context.
  const needsFolder = ['OPEN_FOLDER', 'CREATE_FOLDER', 'CREATE_FILE'].includes(intent.type);
  if (needsFolder && !params.folder && !params.path) {
    if (context.folder?.folder) {
      params.folder = context.folder.folder;
      filled.push('folder');
    } else if (context.folder?.path) {
      params.path = context.folder.path;
      filled.push('folder');
    } else {
      missing = [...new Set([...missing, 'folder'])];
    }
  }
  if (intent.type === 'CLOSE_APP' && !params.app) {
    if (context.app) {
      params.app = context.app;
      filled.push('app');
    } else {
      missing = [...new Set([...missing, 'app'])];
    }
  }
  delete params.refersToContext;
  const resolved: ParsedIntent = {
    ...intent,
    params,
    missing,
    ...(filled.length ? { fromContext: filled } : {}),
  };
  resolved.resolved = intent.resolved && missing.length === 0 && intent.leftovers.length === 0;
  return resolved;
}

// ── Corrections ──────────────────────────────────────────────────────────────

const stripEdges = (s: string) => s.replace(/^[\s,.;:!?…-]+/, '');

/**
 * "Open Chrome… না, Edge খুলে দাও" / "no, actually Edge": a leading marker means the user is correcting the
 * previous command, not issuing an unrelated one. Returns the text after the marker, or undefined.
 */
export function stripCorrectionMarker(input: string): string | undefined {
  const text = canonicalize(input).trim();
  const key = matchKey(text);
  const markers = [...CORRECTION_MARKERS].sort((a, b) => b.length - a.length);
  for (const marker of markers) {
    const m = matchKey(marker).trimEnd();
    if (!m) continue;
    if (key === m) return '';
    if (key.startsWith(m)) {
      const rest = key.slice(m.length);
      // The marker must end at a word boundary ("না" but not "নাম").
      if (/^[\s,.;:!?…-]/.test(rest) || /[,;:!?]$/.test(m)) {
        return stripEdges(text.slice(text.length - rest.length));
      }
    }
  }
  return undefined;
}

/**
 * Applies a correction to the previous intent. The corrected command usually restates only the part that
 * changes ("না, Edge"), or restates the whole command with a different entity.
 */
export function applyCorrection(
  previous: ParsedIntent,
  correction: ParsedCommand,
): ParsedIntent | undefined {
  const next = correction.clauses[0];
  if (!next || correction.clauses.length !== 1) return undefined;

  // A complete new command of the same kind replaces the old one outright.
  if (next.type !== 'UNKNOWN' && next.resolved) {
    return { ...next, fromContext: ['correction'] };
  }
  // A bare replacement ("না, Edge") swaps the corresponding entity in the previous intent.
  const params = { ...previous.params };
  let changed = false;
  if (
    next.params.app &&
    (previous.params.app || previous.type === 'OPEN_APP' || previous.type === 'CLOSE_APP')
  ) {
    params.app = next.params.app;
    changed = true;
  }
  if (next.params.folder && previous.params.folder !== undefined) {
    params.folder = next.params.folder;
    changed = true;
  }
  if (next.params.query && previous.params.query !== undefined) {
    params.query = next.params.query;
    changed = true;
  }
  return changed ? { ...previous, params, fromContext: ['correction'] } : undefined;
}

// ── Yes / No ─────────────────────────────────────────────────────────────────

export type Answer = 'yes' | 'no' | 'unclear';

const YES = new Set(
  [
    'yes',
    'y',
    'yeah',
    'yep',
    'yup',
    'ok',
    'okay',
    'sure',
    'confirm',
    'confirmed',
    'proceed',
    'go ahead',
    'do it',
    'yes please',
    'ok do it',
    'হ্যাঁ',
    'হ্যা',
    'হাঁ',
    'হ্যাঁ করো',
    'জি',
    'জি হ্যাঁ',
    'জি হ্যা',
    'ঠিক আছে',
    'ঠিকই আছে',
    'নিশ্চয়',
    'অবশ্যই',
    'ওকে',
    'ওকে করো',
    'ha',
    'haa',
    'haan',
    'hya',
    'hyan',
    'hae',
    'ji',
    'ji ha',
    'ji hyan',
    'thik ache',
    'thik achhe',
    'oke',
    'okay koro',
  ].map(matchKey),
);
const NO = new Set(
  [
    'no',
    'n',
    'nope',
    'nah',
    'cancel',
    'stop',
    "don't",
    'dont',
    'do not',
    'never mind',
    'nevermind',
    'no thanks',
    'no thank you',
    'abort',
    'না',
    'নাহ',
    'না না',
    'নাহ না',
    'থাক',
    'থাক না',
    'বাদ দাও',
    'বাদ',
    'বাতিল',
    'বাতিল করো',
    'করো না',
    'করবে না',
    'দরকার নেই',
    'না ধন্যবাদ',
    'na',
    'nah na',
    'na na',
    'thak',
    'bad dao',
    'batil',
    'batil koro',
    'koro na',
    'dorkar nai',
    'dorkar nei',
  ].map(matchKey),
);

/**
 * Reads a reply to a confirmation prompt. Deliberately strict: only an exact, unambiguous answer counts.
 * "yes but not that one", "হ্যাঁ কিন্তু…" or anything mixed is `unclear` — and unclear never confirms.
 */
export function parseAnswer(input: string): Answer {
  const key = matchKey(input)
    .replace(/['’`]/g, '')
    .replace(/[.,;:!?…।"()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!key) return 'unclear';
  const yes = YES.has(key);
  const no = NO.has(key);
  if (yes && !no) return 'yes';
  if (no && !yes) return 'no';
  return 'unclear';
}

// ── One-call interpretation ──────────────────────────────────────────────────

export interface Interpretation {
  command: ParsedCommand;
  /** Clauses after reference resolution and correction handling. */
  clauses: ParsedIntent[];
  isCorrection: boolean;
  /** Everything was understood locally and is complete: no planner needed. */
  needsPlanner: boolean;
}

/** Parses a command in the light of the running conversation. */
export function interpret(
  input: string,
  context: ConversationContext,
  options: NormalizeOptions,
): Interpretation {
  const afterMarker = stripCorrectionMarker(input);
  if (afterMarker !== undefined && context.lastIntent) {
    if (afterMarker.length === 0) {
      // A bare "না" is an answer, not a correction; leave it to the confirmation flow.
      const command = parseCommand(input, options);
      return { command, clauses: [], isCorrection: false, needsPlanner: true };
    }
    const command = parseCommand(afterMarker, options);
    const corrected = applyCorrection(context.lastIntent, command);
    if (corrected) {
      const clause = resolveReferences(corrected, context);
      return { command, clauses: [clause], isCorrection: true, needsPlanner: !clause.resolved };
    }
  }
  const command = parseCommand(input, options);
  const clauses = command.clauses.map((clause) => resolveReferences(clause, context));
  const understood = clauses.length > 0 && clauses.every((c) => c.type !== 'UNKNOWN' && c.resolved);
  return { command, clauses, isCorrection: false, needsPlanner: !understood };
}
