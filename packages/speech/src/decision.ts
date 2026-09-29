import { interpret } from '@allaya/language';
import { cleanTranscript } from './transcript';

/**
 * What to do with a finished transcript. This is the low-confidence safety gate (§ voice): a mis-heard word must
 * never become an action. The rules, in priority order:
 *   1. nothing usable            → discard
 *   2. a stop/cancel command      → send immediately (stopping is always safe and must never be delayed)
 *   3. anything destructive       → ALWAYS review, whatever the policy or confidence
 *   4. policy "never"             → review
 *   5. unknown confidence         → review (unless the user chose "always")
 *   6. below the threshold        → review (below a hard floor even "always" reviews)
 */
export type SubmitPolicy = 'never' | 'confident' | 'always';

export type ReviewReason =
  'destructive' | 'policy' | 'low_confidence' | 'unknown_confidence' | 'very_low_confidence';

export type Decision =
  | { action: 'discard'; reason: 'empty'; text: '' }
  | { action: 'send'; text: string; reasons: [] }
  | { action: 'review'; text: string; reasons: ReviewReason[] };

/** Under "always", anything less certain than this is still shown for review. */
export const HARD_CONFIDENCE_FLOOR = 0.4;

export interface DecisionInput {
  transcript: string;
  /** 0..1, or `null` when the provider gave no signal. */
  confidence: number | null;
  policy: SubmitPolicy;
  /** Minimum confidence for auto-send under "confident". */
  threshold: number;
  now?: Date;
}

export function decideSubmission(input: DecisionInput): Decision {
  const text = cleanTranscript(input.transcript);
  if (text === '') return { action: 'discard', reason: 'empty', text: '' };

  const now = input.now ?? new Date();
  const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const { clauses } = interpret(text, {}, { today });

  const onlyControl =
    clauses.length === 1 &&
    (clauses[0]!.type === 'STOP' || clauses[0]!.type === 'CANCEL') &&
    clauses[0]!.resolved;
  if (onlyControl) return { action: 'send', text, reasons: [] };

  const reasons: ReviewReason[] = [];
  if (clauses.some((clause) => clause.destructive)) reasons.push('destructive');

  if (input.policy === 'never') reasons.push('policy');
  else if (input.confidence === null) {
    if (input.policy === 'confident') reasons.push('unknown_confidence');
  } else if (input.confidence < HARD_CONFIDENCE_FLOOR) reasons.push('very_low_confidence');
  else if (input.policy === 'confident' && input.confidence < input.threshold)
    reasons.push('low_confidence');

  return reasons.length > 0
    ? { action: 'review', text, reasons }
    : { action: 'send', text, reasons: [] };
}
