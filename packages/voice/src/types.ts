import type { SttSegment } from '@allaya/speech';

export type SpeechLanguage = 'bn' | 'en';

export interface AudioInput {
  bytes: Uint8Array;
  /** e.g. `audio/webm;codecs=opus`. */
  mimeType: string;
}

export interface TranscribeOptions {
  /** A hint that improves accuracy; `auto` lets the model detect it. */
  language: SpeechLanguage | 'auto';
  /** Vocabulary hint (app names, the user's name…). Never contains secrets. */
  prompt?: string;
  signal?: AbortSignal | undefined;
}

export interface Transcription {
  text: string;
  /** Detected language when the provider reports one we understand. */
  language: SpeechLanguage | null;
  /** 0..1, or `null` when the provider gave no usable signal. */
  confidence: number | null;
  /** True when the audio contained no speech (or only a hallucinated stock phrase). */
  noSpeech: boolean;
  durationSeconds: number | null;
  segments: SttSegment[];
}

export interface SttProvider {
  readonly id: string;
  transcribe(audio: AudioInput, options: TranscribeOptions): Promise<Transcription>;
}

export interface SynthesizeOptions {
  language: SpeechLanguage;
  voice?: string;
  signal?: AbortSignal | undefined;
}

export interface SynthesizedAudio {
  bytes: Uint8Array;
  mimeType: string;
}

export interface TtsProvider {
  readonly id: string;
  synthesize(text: string, options: SynthesizeOptions): Promise<SynthesizedAudio>;
}
