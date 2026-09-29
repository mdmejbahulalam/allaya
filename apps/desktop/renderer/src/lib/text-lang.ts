import { MIN_DETECTION_CONFIDENCE, detectLanguage } from '@allaya/language';

/**
 * The language of a chunk of message text, for the `lang` attribute. It picks the right font/shaping and
 * makes screen readers switch to a Bengali voice. Returns `undefined` when the text is too short to tell.
 */
export function textLang(text: string): 'bn' | 'en' | undefined {
  if (!text.trim()) return undefined;
  const analysis = detectLanguage(text);
  return analysis.confidence >= MIN_DETECTION_CONFIDENCE ? analysis.primary : undefined;
}
