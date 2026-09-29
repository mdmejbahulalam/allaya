import { interpret } from '@allaya/language';
import type { TaskComplexity } from '@allaya/types';

/**
 * How much planning a request needs, decided locally and deterministically — no model call, so an ordinary
 * "open Notepad" never waits for one. Bengali, English and romanized Bengali are all handled:
 *
 *   trivial     one command the language engine fully understands ("Notepad খোলো")
 *   simple      one short request
 *   multi_step  several actions in order, or several sentences
 *   complex     a long or many-part request
 *
 * Only `multi_step` and `complex` are planned; the others run as a single step. The signal is structure (how
 * many actions, how they are chained), never keywords about topics, so it cannot be tricked into skipping the
 * plan for something that needs one — a wrongly "simple" request still runs through the same permission checks.
 */
const SEQUENCE_MARKERS: readonly RegExp[] = [
  // English
  /\b(?:and then|then|after that|afterwards|next|finally|first(?:ly)?|second(?:ly)?|once (?:that|it)(?:'s| is)? done|when (?:that|it)(?:'s| is)? done)\b/i,
  // Bengali (script)
  /(?:তারপর|তার পর|এরপর|এর পর|পরে|শেষে|প্রথমে|তারপরে|এরপরে|শেষ হলে|হয়ে গেলে)/u,
  // Banglish
  /\b(?:tarpor|tarpore|erpor|erpore|er por|pore|sheshe|shesh hole|prothome|protome|tar por)\b/i,
];

const STEP_LIST = /^\s*(?:\d+[.)]|[-*•])\s+/gmu;

const SENTENCE_END = /[.!?।]+(?:\s|$)/gu;

export interface ComplexityResult {
  complexity: TaskComplexity;
  /** Plain-language signals, kept for the timeline and tests. */
  reasons: string[];
}

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

export function classifyComplexity(request: string, now: Date = new Date()): ComplexityResult {
  const text = request.trim();
  const reasons: string[] = [];
  const length = Array.from(text).length;

  const markers = SEQUENCE_MARKERS.reduce(
    (n, pattern) =>
      n + count(text, new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)),
    0,
  );
  const listItems = count(text, STEP_LIST);
  const sentences = Math.max(1, count(text, SENTENCE_END));

  let clauses = 0;
  let understood = false;
  try {
    const result = interpret(
      text,
      {},
      { today: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() } },
    );
    clauses = result.clauses.length;
    understood = !result.needsPlanner;
  } catch {
    // The local parser is only a hint; if it chokes, the structural signals below still decide.
  }

  let score = 0;
  if (markers > 0) {
    score += Math.min(markers, 3);
    reasons.push(`${markers} sequencing word${markers === 1 ? '' : 's'}`);
  }
  if (listItems > 1) {
    score += listItems - 1;
    reasons.push(`${listItems} list items`);
  }
  if (sentences > 1) {
    score += sentences - 1;
    reasons.push(`${sentences} sentences`);
  }
  if (clauses > 1) {
    score += clauses - 1;
    reasons.push(`${clauses} separate actions`);
  }
  if (length > 400) {
    score += 2;
    reasons.push('a long request');
  } else if (length > 220) {
    score += 1;
    reasons.push('a fairly long request');
  }

  if (score >= 4) return { complexity: 'complex', reasons };
  if (score >= 1) return { complexity: 'multi_step', reasons };
  if (understood && clauses === 1 && length <= 80) {
    return { complexity: 'trivial', reasons: ['one command that was understood on the spot'] };
  }
  return { complexity: 'simple', reasons: reasons.length ? reasons : ['one short request'] };
}

/** Whether a request of this size gets a written plan first. */
export const needsPlanning = (complexity: TaskComplexity): boolean =>
  complexity === 'multi_step' || complexity === 'complex';
