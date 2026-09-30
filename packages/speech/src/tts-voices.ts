/**
 * The prebuilt voices of the expressive text-to-speech model. Names and one-word characters are from the
 * provider's published list; the model speaks any of them in every language it supports, Bengali included.
 */
export interface ExpressiveVoice {
  name: string;
  /** One word: how the voice sounds (the `tone.*` label in the interface). */
  tone: string;
}

export const EXPRESSIVE_VOICES: readonly ExpressiveVoice[] = [
  { name: 'Zephyr', tone: 'bright' },
  { name: 'Puck', tone: 'upbeat' },
  { name: 'Charon', tone: 'informative' },
  { name: 'Kore', tone: 'firm' },
  { name: 'Fenrir', tone: 'excitable' },
  { name: 'Leda', tone: 'youthful' },
  { name: 'Orus', tone: 'firm' },
  { name: 'Aoede', tone: 'breezy' },
  { name: 'Callirrhoe', tone: 'easygoing' },
  { name: 'Autonoe', tone: 'bright' },
  { name: 'Enceladus', tone: 'breathy' },
  { name: 'Iapetus', tone: 'clear' },
  { name: 'Umbriel', tone: 'easygoing' },
  { name: 'Algieba', tone: 'smooth' },
  { name: 'Despina', tone: 'smooth' },
  { name: 'Erinome', tone: 'clear' },
  { name: 'Algenib', tone: 'gravelly' },
  { name: 'Rasalgethi', tone: 'informative' },
  { name: 'Laomedeia', tone: 'upbeat' },
  { name: 'Achernar', tone: 'soft' },
  { name: 'Alnilam', tone: 'firm' },
  { name: 'Schedar', tone: 'even' },
  { name: 'Gacrux', tone: 'mature' },
  { name: 'Pulcherrima', tone: 'forward' },
  { name: 'Achird', tone: 'friendly' },
  { name: 'Zubenelgenubi', tone: 'casual' },
  { name: 'Vindemiatrix', tone: 'gentle' },
  { name: 'Sadachbia', tone: 'lively' },
  { name: 'Sadaltager', tone: 'knowledgeable' },
  { name: 'Sulafat', tone: 'warm' },
];

export const DEFAULT_EXPRESSIVE_VOICE = 'Sulafat';
/** The model to start from. The list of models the account can use is fetched, so this is only a starting point. */
export const DEFAULT_EXPRESSIVE_MODEL = 'gemini-3.1-flash-tts-preview';

/** Starting points for the "how should it sound" box. Free text is always allowed. */
export const STYLE_PRESETS = [
  'friendly',
  'calm',
  'energetic',
  'professional',
  'storyteller',
] as const;
export type StylePreset = (typeof STYLE_PRESETS)[number];

/** The sentence a preset stands for (English: the model follows English direction for every language). */
export const STYLE_TEXT: Record<StylePreset, string> = {
  friendly: 'A warm, friendly personal assistant. Natural, relaxed pace, smiling tone.',
  calm: 'Calm and reassuring. Slow, even pace, soft and steady.',
  energetic: 'Upbeat and energetic. Bright, quick, enthusiastic without shouting.',
  professional: 'Clear and professional. Measured pace, confident, neutral tone.',
  storyteller: 'An engaging storyteller. Expressive, with natural pauses and shifts in mood.',
};
