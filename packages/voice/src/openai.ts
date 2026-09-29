import { send, type FetchLike, type HttpOptions } from '@allaya/ai';
import { AllayaError } from '@allaya/shared';
import {
  cleanTranscript,
  confidenceFromSegments,
  isLikelyHallucination,
  type SttSegment,
} from '@allaya/speech';
import type {
  AudioInput,
  SpeechLanguage,
  SttProvider,
  SynthesizeOptions,
  SynthesizedAudio,
  TranscribeOptions,
  Transcription,
  TtsProvider,
} from './types';

/**
 * Everything the OpenAI-compatible audio endpoints need from the trusted host. The key is fetched per request
 * and never retained.
 */
export interface AudioEndpoint {
  getApiKey(): Promise<string>;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** The service accepts at most 25 MB. Stay well under it so we fail with a clear message, not an HTTP error. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function httpOptions(endpoint: AudioEndpoint): HttpOptions {
  return {
    provider: 'openai',
    fetch: endpoint.fetch ?? ((url, init) => fetch(url, init)),
    timeoutMs: endpoint.timeoutMs ?? 60_000,
    ...(endpoint.maxRetries !== undefined ? { maxRetries: endpoint.maxRetries } : {}),
    ...(endpoint.backoffMs !== undefined ? { backoffMs: endpoint.backoffMs } : {}),
  };
}

const bearer = async (endpoint: AudioEndpoint) => ({
  authorization: `Bearer ${await endpoint.getApiKey()}`,
});

function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/flac': 'flac',
  };
  return map[base] ?? 'webm';
}

/** Whisper reports the language as an English name ("bengali"), not a code. */
export function normalizeLanguage(name: unknown): SpeechLanguage | null {
  if (typeof name !== 'string') return null;
  const value = name.trim().toLowerCase();
  if (value === 'bn' || value === 'bengali' || value === 'bangla') return 'bn';
  if (value === 'en' || value === 'english') return 'en';
  return null;
}

interface VerboseJson {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: Array<Record<string, unknown>>;
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function parseTranscription(body: VerboseJson): Transcription {
  const segments: SttSegment[] = (body.segments ?? []).map((s) => ({
    text: typeof s['text'] === 'string' ? s['text'] : '',
    ...(num(s['start']) !== undefined ? { start: num(s['start'])! } : {}),
    ...(num(s['end']) !== undefined ? { end: num(s['end'])! } : {}),
    ...(num(s['avg_logprob']) !== undefined ? { avgLogprob: num(s['avg_logprob'])! } : {}),
    ...(num(s['no_speech_prob']) !== undefined ? { noSpeechProb: num(s['no_speech_prob'])! } : {}),
    ...(num(s['compression_ratio']) !== undefined
      ? { compressionRatio: num(s['compression_ratio'])! }
      : {}),
  }));
  const text = cleanTranscript(typeof body.text === 'string' ? body.text : '');
  const worst = (pick: (s: SttSegment) => number | undefined, better: 'max' | 'min') => {
    const values = segments.map(pick).filter((v): v is number => v !== undefined);
    return values.length === 0
      ? undefined
      : better === 'max'
        ? Math.max(...values)
        : Math.min(...values);
  };
  const noSpeech = isLikelyHallucination(text, {
    ...(worst((s) => s.noSpeechProb, 'max') !== undefined
      ? { noSpeechProb: worst((s) => s.noSpeechProb, 'max')! }
      : {}),
    ...(worst((s) => s.avgLogprob, 'min') !== undefined
      ? { avgLogprob: worst((s) => s.avgLogprob, 'min')! }
      : {}),
    ...(worst((s) => s.compressionRatio, 'max') !== undefined
      ? { compressionRatio: worst((s) => s.compressionRatio, 'max')! }
      : {}),
  });
  return {
    text: noSpeech ? '' : text,
    language: normalizeLanguage(body.language),
    confidence: noSpeech ? null : confidenceFromSegments(segments),
    noSpeech,
    durationSeconds: num(body.duration) ?? null,
    segments,
  };
}

/**
 * Speech-to-text over the OpenAI-style `/audio/transcriptions` endpoint (also implemented by several other
 * vendors). `whisper-1` is the default because it is the model that returns per-segment log-probabilities, which
 * is what the low-confidence safety gate needs; models that return plain text yield `confidence: null`.
 */
export class OpenAiCompatibleStt implements SttProvider {
  readonly id = 'openai';

  constructor(
    private readonly endpoint: AudioEndpoint,
    private readonly model = 'whisper-1',
  ) {}

  async transcribe(audio: AudioInput, options: TranscribeOptions): Promise<Transcription> {
    if (audio.bytes.byteLength === 0) {
      throw new AllayaError('No audio was recorded', { code: 'INVALID_INPUT' });
    }
    if (audio.bytes.byteLength > MAX_AUDIO_BYTES) {
      throw new AllayaError('That recording is too long to transcribe', { code: 'INVALID_INPUT' });
    }
    const form = new FormData();
    const copy = new Uint8Array(audio.bytes); // detach from any shared buffer
    form.append(
      'file',
      new Blob([copy], { type: audio.mimeType }),
      `speech.${extensionFor(audio.mimeType)}`,
    );
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    if (options.language !== 'auto') form.append('language', options.language);
    if (options.prompt) form.append('prompt', options.prompt);

    const { response, dispose } = await send(httpOptions(this.endpoint), {
      url: `${this.endpoint.baseUrl ?? DEFAULT_BASE_URL}/audio/transcriptions`,
      headers: await bearer(this.endpoint),
      rawBody: form,
      signal: options.signal,
    });
    try {
      const body = (await response.json()) as VerboseJson;
      return parseTranscription(body);
    } catch (cause) {
      throw new AllayaError('The speech service returned an unreadable response', {
        code: 'PROVIDER_ERROR',
        cause,
      });
    } finally {
      dispose();
    }
  }
}

const TTS_MIME = 'audio/mpeg';

/** Text-to-speech over `/audio/speech`. Returns MP3, which every Chromium build can play. */
export class OpenAiCompatibleTts implements TtsProvider {
  readonly id = 'openai';

  constructor(
    private readonly endpoint: AudioEndpoint,
    private readonly model = 'gpt-4o-mini-tts',
    private readonly defaultVoice = 'alloy',
  ) {}

  async synthesize(text: string, options: SynthesizeOptions): Promise<SynthesizedAudio> {
    const input = text.trim();
    if (!input) throw new AllayaError('There is nothing to say', { code: 'INVALID_INPUT' });
    const { response, dispose } = await send(httpOptions(this.endpoint), {
      url: `${this.endpoint.baseUrl ?? DEFAULT_BASE_URL}/audio/speech`,
      headers: await bearer(this.endpoint),
      body: {
        model: this.model,
        voice: options.voice || this.defaultVoice,
        input,
        response_format: 'mp3',
        // Steers gpt-4o-mini-tts; ignored by models that do not support instructions.
        ...(options.language === 'bn' ? { instructions: 'Speak in natural, clear Bengali.' } : {}),
      },
      signal: options.signal,
    });
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new AllayaError('The speech service returned no audio', { code: 'PROVIDER_ERROR' });
      }
      return { bytes, mimeType: TTS_MIME };
    } finally {
      dispose();
    }
  }
}
