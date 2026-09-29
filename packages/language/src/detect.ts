import {
  BANGLISH_WORDS,
  BRITISH_MARKERS,
  ENGLISH_WORDS,
  UNIVERSAL_WORDS,
} from './lexicon-banglish';
import { canonicalize, countScripts, hasBengali, tokenize } from './script';

export type DetectedScript = 'bn' | 'en' | 'mixed-bn-en' | 'romanized-bn';
export type DetectedLocale = 'bn-BD' | 'en-US' | 'en-GB';

export interface LanguageAnalysis {
  language: DetectedScript;
  locale: DetectedLocale;
  /** The language Allaya should *answer* in. Mixed input is answered in Bengali when Bengali carries the grammar. */
  primary: 'bn' | 'en';
  /** 0..1. Very short or ambiguous input scores low so callers can fall back to conversation history. */
  confidence: number;
  counts: { bengaliTokens: number; latinTokens: number; banglishHits: number; englishHits: number };
}

const stripPunct = (word: string) => word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');

/**
 * Detects Bengali / English / Banglish / code-switched input.
 *
 * Bengali script is unambiguous. The hard case is Latin script, where Banglish ("amar Downloads folder ta
 * open koro") and English differ only by vocabulary, so it is scored against a lexicon of romanised-Bengali
 * words that are not English words, balanced against common English words.
 */
export function detectLanguage(input: string): LanguageAnalysis {
  const text = canonicalize(input);
  const scripts = countScripts(text);
  const words = tokenize(text);

  const bengaliTokens = words.filter((w) => hasBengali(w.text));
  const latinTokens = words.filter((w) => !hasBengali(w.text) && /[A-Za-z]/.test(w.text));
  const latinWords = latinTokens
    .map((w) => stripPunct(w.text))
    .filter((w) => w && !UNIVERSAL_WORDS.has(w));

  const banglishHits = latinWords.filter((w) => BANGLISH_WORDS.has(w)).length;
  const englishHits = latinWords.filter((w) => ENGLISH_WORDS.has(w)).length;
  const counts = {
    bengaliTokens: bengaliTokens.length,
    latinTokens: latinTokens.length,
    banglishHits,
    englishHits,
  };

  const locale = (language: DetectedScript): DetectedLocale => {
    if (language !== 'en') return 'bn-BD';
    return latinWords.some((w) => BRITISH_MARKERS.has(w)) ? 'en-GB' : 'en-US';
  };
  const done = (
    language: DetectedScript,
    primary: 'bn' | 'en',
    confidence: number,
  ): LanguageAnalysis => ({
    language,
    locale: locale(language),
    primary,
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
    counts,
  });

  const letters = scripts.bengali + scripts.latin + scripts.other;
  if (letters === 0) return done('en', 'en', 0); // digits/punctuation only: no evidence either way

  // ── Bengali script present ────────────────────────────────────────────────
  if (bengaliTokens.length > 0) {
    if (latinTokens.length === 0)
      return done('bn', 'bn', 0.6 + Math.min(0.4, scripts.bengali / 30));
    const bnRatio = bengaliTokens.length / (bengaliTokens.length + latinTokens.length);
    // English sentence that merely contains a Bengali name/word stays English; otherwise Bengali carries the grammar.
    const primary = bnRatio >= 0.3 || englishHits === 0 ? 'bn' : 'en';
    return done('mixed-bn-en', primary, 0.75 + Math.min(0.2, words.length / 40));
  }

  // ── Latin script only: Banglish or English ────────────────────────────────
  if (banglishHits === 0) {
    // No romanised-Bengali evidence. Confidence tracks how much English evidence there is.
    const confidence = englishHits === 0 ? 0.4 : 0.6 + Math.min(0.35, englishHits / 10);
    return done('en', 'en', words.length === 1 && englishHits === 0 ? 0.3 : confidence);
  }
  const ratio = banglishHits / (banglishHits + englishHits);
  const romanized = ratio >= 0.5 || (banglishHits >= 2 && ratio >= 0.34);
  if (romanized)
    return done('romanized-bn', 'bn', 0.55 + Math.min(0.4, banglishHits * 0.1 + ratio * 0.2));
  return done('en', 'en', 0.5 + (1 - ratio) * 0.2);
}

export type ResponsePolicy = 'auto' | 'bn' | 'en' | 'mixed';
export type ResponseLanguageReason = 'policy' | 'explicit' | 'detected' | 'history' | 'ui';

export interface ResolvedResponseLanguage {
  language: 'bn' | 'en' | 'mixed';
  reason: ResponseLanguageReason;
}

/** Below this, a detection is too weak to override what the conversation has already established. */
export const MIN_DETECTION_CONFIDENCE = 0.55;

/**
 * Remembers how the conversation has been going so replies stay in the user's language: an explicit
 * "বাংলায় কথা বলো" / "Speak English" sticks until changed, and one-word or ambiguous messages ("ok", "haan")
 * inherit the language of the previous turn instead of flipping.
 */
export class LanguageSession {
  private explicit: 'bn' | 'en' | null = null;
  private last: 'bn' | 'en' | null = null;

  /** Rebuilds a session from persisted state (the explicit choice and the last confidently detected language). */
  static restore(state: {
    explicit?: 'bn' | 'en' | null | undefined;
    last?: 'bn' | 'en' | null | undefined;
  }): LanguageSession {
    const session = new LanguageSession();
    session.explicit = state.explicit ?? null;
    session.last = state.last ?? null;
    return session;
  }

  observe(analysis: LanguageAnalysis): void {
    if (analysis.confidence >= MIN_DETECTION_CONFIDENCE) this.last = analysis.primary;
  }

  /** `null` returns to automatic detection. */
  setExplicit(language: 'bn' | 'en' | null): void {
    this.explicit = language;
  }

  get explicitLanguage(): 'bn' | 'en' | null {
    return this.explicit;
  }

  resolve(
    policy: ResponsePolicy,
    analysis: LanguageAnalysis,
    uiFallback: 'bn' | 'en',
  ): ResolvedResponseLanguage {
    // "Speak English" said in *this* conversation is more specific than the app-wide default, so it wins.
    if (this.explicit) return { language: this.explicit, reason: 'explicit' };
    if (policy !== 'auto') return { language: policy, reason: 'policy' };
    if (analysis.confidence >= MIN_DETECTION_CONFIDENCE)
      return { language: analysis.primary, reason: 'detected' };
    if (this.last) return { language: this.last, reason: 'history' };
    return { language: uiFallback, reason: 'ui' };
  }
}
