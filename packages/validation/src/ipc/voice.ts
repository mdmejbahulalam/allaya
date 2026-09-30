import { z } from 'zod';
import { spec, noPayload } from './common';

/** Audio arrives as base64 (structured-clone friendly, size-checked before decoding). 20 MB of audio ≈ 27 M chars. */
export const MAX_AUDIO_BASE64_CHARS = 28_000_000;
export const MAX_SPEECH_CHARS = 4000;

const audioMimeSchema = z
  .string()
  .regex(
    /^audio\/(webm|ogg|wav|x-wav|mpeg|mp4|m4a|flac)(;[\w=.\-\s,]*)?$/i,
    'Unsupported audio type',
  );

export const voiceCapabilitiesSchema = z.object({
  /** The user has turned voice on (microphone consent). */
  enabled: z.boolean(),
  /** A speech-to-text provider is configured (an OpenAI key is stored). */
  sttAvailable: z.boolean(),
  /** Which service will transcribe (`null` when none can). Audio for Google is sent as WAV. */
  sttEngine: z.enum(['openai', 'gemini']).nullable(),
  cloudTtsAvailable: z.boolean(),
  /** A Google key is stored, so the expressive voice can speak. */
  expressiveTtsAvailable: z.boolean(),
});
export type VoiceCapabilities = z.infer<typeof voiceCapabilitiesSchema>;

export const submissionDecisionSchema = z.object({
  /** `send`: safe to submit as if typed. `review`: show the transcript and let the user confirm or edit. */
  action: z.enum(['send', 'review', 'discard']),
  reasons: z.array(
    z.enum([
      'destructive',
      'policy',
      'low_confidence',
      'unknown_confidence',
      'very_low_confidence',
    ]),
  ),
});

export const transcriptionResultSchema = z.object({
  text: z.string(),
  language: z.enum(['bn', 'en']).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  noSpeech: z.boolean(),
  decision: submissionDecisionSchema,
});
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;

export const voiceContract = {
  invoke: {
    'voice:getCapabilities': spec(noPayload, voiceCapabilitiesSchema),
    'voice:transcribe': spec(
      z.object({
        audio: z.string().min(1).max(MAX_AUDIO_BASE64_CHARS),
        mimeType: audioMimeSchema,
      }),
      transcriptionResultSchema,
    ),
    'voice:synthesize': spec(
      z.object({
        text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
        language: z.enum(['bn', 'en']),
        /** Try a voice, model or style without saving it (the settings page's preview). Omitted: what is saved. */
        engine: z.enum(['cloud', 'gemini']).optional(),
        voice: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,40}$/)
          .optional(),
        style: z.string().max(300).optional(),
      }),
      z.object({ audio: z.string(), mimeType: z.enum(['audio/mpeg', 'audio/wav']) }),
    ),
    /** The speech models the stored Google key can use. Empty (not an error) when the list cannot be read. */
    'voice:listSpeechModels': spec(
      noPayload,
      z.object({ models: z.array(z.string()), fetched: z.boolean() }),
    ),
  },
  events: {},
} as const;
