import { send, type HttpOptions } from '@allaya/ai';
import { AllayaError } from '@allaya/shared';
import {
  DEFAULT_EXPRESSIVE_MODEL,
  DEFAULT_EXPRESSIVE_VOICE,
  cleanAudioTags,
  stripAudioTags,
} from '@allaya/speech';
import type { AudioEndpoint } from './openai';
import type { SynthesizeOptions, SynthesizedAudio, TtsProvider } from './types';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_RATE = 24_000;
export const modelPath = (model: string) => encodeURIComponent(model.replace(/^models\//, ''));

export function httpOptions(endpoint: AudioEndpoint): HttpOptions {
  return {
    provider: 'google',
    fetch: endpoint.fetch ?? ((url, init) => fetch(url, init)),
    // A whole clip is generated before any of it comes back, so allow longer than a chat request.
    timeoutMs: endpoint.timeoutMs ?? 90_000,
    ...(endpoint.maxRetries !== undefined ? { maxRetries: endpoint.maxRetries } : {}),
    ...(endpoint.backoffMs !== undefined ? { backoffMs: endpoint.backoffMs } : {}),
  };
}

export const headers = async (endpoint: AudioEndpoint) => ({
  'x-goog-api-key': await endpoint.getApiKey(),
  'content-type': 'application/json',
});

/** Wraps raw 16-bit little-endian mono PCM in a WAV header, which every browser can play. */
export function pcmToWav(pcm: Uint8Array, sampleRate = DEFAULT_RATE): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

export interface GeminiTtsOptions {
  model?: string;
  voice?: string;
  /** How it should sound, in plain words: "warm, calm, unhurried". Sent as direction, never read aloud. */
  style?: string;
}

/**
 * What the model is given: direction first, then the words. The model is told the words are a transcript, so it
 * speaks them rather than the direction. Tags such as `[whispers]` stay in the transcript, where the model expects
 * them.
 */
export function buildSpeechPrompt(
  text: string,
  options: { style?: string | undefined; language: 'bn' | 'en' },
): string {
  const notes: string[] = [];
  const style = options.style?.replace(/\s+/g, ' ').trim();
  if (style) notes.push(`Style: ${style}`);
  notes.push(
    options.language === 'bn'
      ? 'Language: Bengali (Bangladesh). Pronounce every word as a native speaker would.'
      : 'Language: English.',
  );
  return `### DIRECTOR'S NOTES\n${notes.join('\n')}\n\n#### TRANSCRIPT\n${text}`;
}

interface GenerateResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
}

const rateOf = (mimeType: string | undefined): number => {
  const match = /rate=(\d{4,6})/i.exec(mimeType ?? '');
  return match ? Number(match[1]) : DEFAULT_RATE;
};

/** Pulls the audio out of a response; `undefined` when the model answered in text instead (it sometimes does). */
export function readAudio(body: GenerateResponse): SynthesizedAudio | undefined {
  for (const part of body.candidates?.[0]?.content?.parts ?? []) {
    const data = part.inlineData?.data;
    if (!data) continue;
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    if (bytes.byteLength === 0) continue;
    const mime = part.inlineData?.mimeType ?? '';
    // Anything that is already a container plays as it is; raw PCM gets a header.
    if (/^audio\/(wav|x-wav|mpeg|mp3|ogg|webm)/i.test(mime)) {
      return { bytes, mimeType: mime.split(';')[0]!.toLowerCase() };
    }
    return { bytes: pcmToWav(bytes, rateOf(mime)), mimeType: 'audio/wav' };
  }
  return undefined;
}

/**
 * Speech from Google's expressive text-to-speech model over `generateContent`: 30 voices, many languages (Bengali
 * included), delivery steered by a style note and `[tags]` in the text. The key is read per request from the host.
 */
export class GeminiTts implements TtsProvider {
  readonly id = 'gemini';

  constructor(
    private readonly endpoint: AudioEndpoint,
    private readonly defaults: GeminiTtsOptions = {},
  ) {}

  async synthesize(
    text: string,
    options: SynthesizeOptions & { style?: string | undefined; model?: string },
  ): Promise<SynthesizedAudio> {
    const words = cleanAudioTags(text);
    // Tags alone are not something to say.
    if (!stripAudioTags(words).trim())
      throw new AllayaError('There is nothing to say', { code: 'INVALID_INPUT' });
    const model = options.model ?? this.defaults.model ?? DEFAULT_EXPRESSIVE_MODEL;
    const voice = options.voice || this.defaults.voice || DEFAULT_EXPRESSIVE_VOICE;
    const request = {
      url: `${this.endpoint.baseUrl ?? GEMINI_BASE_URL}/models/${modelPath(model)}:generateContent`,
      headers: await headers(this.endpoint),
      body: {
        contents: [
          {
            parts: [
              {
                text: buildSpeechPrompt(words, {
                  style: options.style ?? this.defaults.style,
                  language: options.language,
                }),
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      },
      signal: options.signal,
    };
    // The model now and then returns text instead of audio for a perfectly good request; once more is enough.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { response, dispose } = await send(httpOptions(this.endpoint), request);
      try {
        const body = (await response.json()) as GenerateResponse;
        if (body.promptFeedback?.blockReason) {
          throw new AllayaError('The speech service declined to speak that text', {
            code: 'PROVIDER_ERROR',
          });
        }
        const audio = readAudio(body);
        if (audio) return audio;
      } catch (cause) {
        if (cause instanceof AllayaError) throw cause;
        throw new AllayaError('The speech service returned an unreadable response', {
          code: 'PROVIDER_ERROR',
          cause,
        });
      } finally {
        dispose();
      }
    }
    throw new AllayaError('The speech service returned no audio', { code: 'PROVIDER_ERROR' });
  }
}

/** The speech models this key can use (`gemini-…-tts…`), newest names first. Empty when the list cannot be read. */
export async function listSpeechModels(
  endpoint: AudioEndpoint,
  signal?: AbortSignal,
): Promise<string[]> {
  const found = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const { response, dispose } = await send(httpOptions(endpoint), {
      url: `${endpoint.baseUrl ?? GEMINI_BASE_URL}/models?pageSize=1000${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
      }`,
      method: 'GET',
      headers: await headers(endpoint),
      signal,
    });
    try {
      const body = (await response.json()) as {
        models?: Array<{ name?: string }>;
        nextPageToken?: string;
      };
      for (const model of body.models ?? []) {
        const id = model.name?.replace(/^models\//, '');
        if (id && /tts/i.test(id) && /^[A-Za-z0-9._-]{1,80}$/.test(id)) found.add(id);
      }
      pageToken = body.nextPageToken;
    } finally {
      dispose();
    }
    if (!pageToken) break;
  }
  return [...found].sort((a, b) => b.localeCompare(a));
}
