/**
 * Speech-to-text output is untrusted input: silence produces confident-looking nonsense, and a low-confidence
 * transcript must never be acted on as if the user had typed it.
 */
export interface SttSegment {
  text: string;
  start?: number;
  end?: number;
  /** Average token log-probability (≤ 0). Whisper-style. */
  avgLogprob?: number;
  /** Probability the segment contains no speech (0..1). */
  noSpeechProb?: number;
  /** gzip compression ratio of the text; very high values indicate a repetition loop. */
  compressionRatio?: number;
}

/** Zero-width space/joiners and the BOM (written as escapes so the source stays readable). */
const INVISIBLE = new RegExp('[\\u200B-\\u200D\\uFEFF]', 'g');

export function cleanTranscript(text: string): string {
  return text
    .normalize('NFC')
    .replace(INVISIBLE, '') // zero-width characters carry no speech content
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Confidence in 0..1 from segment log-probabilities, weighted by segment length and discounted by the chance
 * that the audio was not speech. `null` when the provider gave no usable signal — callers must treat that as
 * "unknown", not as "high".
 */
export function confidenceFromSegments(segments: readonly SttSegment[] | undefined): number | null {
  if (!segments || segments.length === 0) return null;
  let weight = 0;
  let logprob = 0;
  let noSpeech = 0;
  let counted = 0;
  for (const segment of segments) {
    if (typeof segment.avgLogprob !== 'number' || !Number.isFinite(segment.avgLogprob)) continue;
    const w = Math.max(1, segment.text.trim().length);
    weight += w;
    logprob += segment.avgLogprob * w;
    noSpeech = Math.max(noSpeech, segment.noSpeechProb ?? 0);
    counted += 1;
  }
  if (counted === 0 || weight === 0) return null;
  const perToken = Math.exp(Math.min(0, logprob / weight));
  const value = perToken * (1 - Math.min(1, noSpeech) * 0.5);
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/** Phrases speech models tend to emit for silence or background noise (in English and Bengali). */
const SILENCE_PHRASES = [
  /^(thanks|thank you)( so much)?( for (watching|listening))?[.!]*$/i,
  /^(please )?(like and )?subscribe( to (my|the) channel)?[.!]*$/i,
  /^subtitles? (by|from) .+$/i,
  /^(bye|goodbye)[.!]*$/i,
  /^you[.!]*$/i,
  /^(ধন্যবাদ|ধন্যবাদ সবাইকে|দেখার জন্য ধন্যবাদ)[।.!]*$/u,
  /^\.+$/,
];

export interface HallucinationSignals {
  noSpeechProb?: number;
  avgLogprob?: number;
  compressionRatio?: number;
}

/** True when the transcript is almost certainly not something the user said. */
export function isLikelyHallucination(text: string, signals: HallucinationSignals = {}): boolean {
  const cleaned = cleanTranscript(text);
  if (cleaned === '') return true;
  const { noSpeechProb = 0, avgLogprob, compressionRatio } = signals;
  // Whisper's own reference rule for skipping a segment.
  if (noSpeechProb > 0.6 && (avgLogprob === undefined || avgLogprob < -1)) return true;
  // Runaway repetition ("ha ha ha ha …").
  if (compressionRatio !== undefined && compressionRatio > 2.4) return true;
  // A stock phrase is only suspicious when the audio also looked like non-speech.
  if (noSpeechProb > 0.25 && SILENCE_PHRASES.some((pattern) => pattern.test(cleaned))) return true;
  return false;
}
