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
  cloudTtsAvailable: z.boolean(),
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
      }),
      z.object({ audio: z.string(), mimeType: z.literal('audio/mpeg') }),
    ),
  },
  events: {},
} as const;
