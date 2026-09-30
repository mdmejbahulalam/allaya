import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptionResult, VoiceCapabilities } from '@allaya/validation';
import { API_KEY } from '../helpers/anthropic';
import { json } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';
import type { FetchLike } from '@allaya/ai';

let backend: TestBackend;
afterEach(() => backend?.dispose());

type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;

const OPENAI_KEY = 'sk-proj-SECRETSECRETSECRETSECRET';
const b64 = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString('base64');
const AUDIO = b64(new Uint8Array(3000).fill(9));

interface Seen {
  url: string;
  authorization?: string;
  form?: FormData;
  json?: unknown;
  signal?: AbortSignal;
}

const transcript = (text: string, logprob = -0.1, noSpeech = 0.01) => ({
  text,
  language: 'bengali',
  duration: 2,
  segments: [{ text, avg_logprob: logprob, no_speech_prob: noSpeech, compression_ratio: 1.1 }],
});

/** A backend whose OpenAI endpoints are answered by `respond`. */
function withOpenAi(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const entry: Seen = {
      url,
      ...(headers['authorization'] ? { authorization: headers['authorization'] } : {}),
    };
    if (init?.signal) entry.signal = init.signal;
    if (init?.body instanceof FormData) entry.form = init.body;
    else if (typeof init?.body === 'string') entry.json = JSON.parse(init.body);
    if (init?.signal?.aborted) throw init.signal.reason;
    if (url.endsWith('/models')) return json({ data: [{ id: 'gpt-5', created: 1 }] });
    seen.push(entry);
    return respond(entry);
  };
  backend = createTestBackend({ fetch: fetchFn });
  return seen;
}

const enableVoice = () => backend.call('settings:set', { key: 'voice.enabled', value: true });
const addOpenAiKey = () =>
  backend.call('providers:setKey', { providerId: 'openai', apiKey: OPENAI_KEY });
const transcribe = async () =>
  backend.call('voice:transcribe', { audio: AUDIO, mimeType: 'audio/webm;codecs=opus' });

describe('voice capabilities', () => {
  it('starts off, with no speech provider', async () => {
    backend = createTestBackend();
    expect(data(await backend.call('voice:getCapabilities'))).toEqual({
      enabled: false,
      sttAvailable: false,
      sttEngine: null,
      cloudTtsAvailable: false,
      expressiveTtsAvailable: false,
    });
  });

  it('reflects consent and the stored OpenAI key', async () => {
    withOpenAi(() => json({}));
    await addOpenAiKey();
    await enableVoice();
    expect(data(await backend.call('voice:getCapabilities'))).toEqual({
      enabled: true,
      sttAvailable: true,
      sttEngine: 'openai',
      cloudTtsAvailable: true,
      expressiveTtsAvailable: false,
    });
  });

  it('an Anthropic key alone does not provide speech-to-text', async () => {
    backend = createTestBackend();
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
    expect(
      data<{ sttAvailable: boolean }>(await backend.call('voice:getCapabilities')).sttAvailable,
    ).toBe(false);
  });
});

describe('consent gate', () => {
  it('refuses to transcribe or synthesize until the user has turned voice on — without touching the network', async () => {
    const seen = withOpenAi(() => json(transcript('x')));
    await addOpenAiKey();
    expect(await transcribe()).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(await backend.call('voice:synthesize', { text: 'hi', language: 'en' })).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_REQUIRED' },
    });
    expect(seen).toHaveLength(0);
  });
});

describe('transcription', () => {
  it('sends a confident Bengali command straight through', async () => {
    const seen = withOpenAi(() => json(transcript('Downloads folder টা খুলে দাও')));
    await addOpenAiKey();
    await enableVoice();

    const result = data<TranscriptionResult>(await transcribe());
    expect(result).toMatchObject({
      text: 'Downloads folder টা খুলে দাও',
      language: 'bn',
      noSpeech: false,
      decision: { action: 'send', reasons: [] },
    });
    expect(result.confidence).toBeGreaterThan(0.8);

    expect(seen[0]!.url).toContain('/audio/transcriptions');
    expect(seen[0]!.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect((seen[0]!.form!.get('file') as File).size).toBe(3000);
    expect(seen[0]!.form!.get('model')).toBe('whisper-1');
    expect(backend.container.runs.active()).toEqual([]);
  });

  it('holds a low-confidence transcript for review', async () => {
    withOpenAi(() => json(transcript('Chrome খুলে দাও', -0.9)));
    await addOpenAiKey();
    await enableVoice();
    const result = data<TranscriptionResult>(await transcribe());
    expect(result.decision).toEqual({ action: 'review', reasons: ['low_confidence'] });
    expect(result.text).toBe('Chrome খুলে দাও'); // the user can still read and confirm it
  });

  it('always holds a destructive command for review, even at 100% confidence and policy "always"', async () => {
    withOpenAi(() => json(transcript('report.docx ডিলিট করে দাও', -0.001, 0)));
    await addOpenAiKey();
    await enableVoice();
    await backend.call('settings:set', { key: 'voice.autoSend', value: 'always' });
    const result = data<TranscriptionResult>(await transcribe());
    expect(result.decision.action).toBe('review');
    expect(result.decision.reasons).toContain('destructive');
  });

  it("honours the user's threshold and policy settings", async () => {
    withOpenAi(() => json(transcript('Chrome খুলে দাও', -0.3))); // ≈ 0.74 confident
    await addOpenAiKey();
    await enableVoice();
    expect(data<TranscriptionResult>(await transcribe()).decision.action).toBe('send');
    await backend.call('settings:set', { key: 'voice.confidenceThreshold', value: 0.9 });
    expect(data<TranscriptionResult>(await transcribe()).decision.action).toBe('review');
    await backend.call('settings:set', { key: 'voice.autoSend', value: 'never' });
    await backend.call('settings:set', { key: 'voice.confidenceThreshold', value: 0.5 });
    expect(data<TranscriptionResult>(await transcribe()).decision).toEqual({
      action: 'review',
      reasons: ['policy'],
    });
  });

  it('discards silence: a hallucinated stock phrase never reaches the chat', async () => {
    withOpenAi(() => json(transcript('Thanks for watching!', -1.4, 0.9)));
    await addOpenAiKey();
    await enableVoice();
    const result = data<TranscriptionResult>(await transcribe());
    expect(result).toMatchObject({
      text: '',
      noSpeech: true,
      confidence: null,
      decision: { action: 'discard' },
    });
  });

  it('passes the language hint and model from settings', async () => {
    const seen = withOpenAi(() => json(transcript('hello')));
    await addOpenAiKey();
    await enableVoice();
    await backend.call('settings:set', { key: 'voice.inputLanguage', value: 'bn' });
    await backend.call('settings:set', { key: 'voice.sttModel', value: 'gpt-4o-transcribe' });
    await transcribe();
    expect(seen[0]!.form!.get('language')).toBe('bn');
    expect(seen[0]!.form!.get('model')).toBe('gpt-4o-transcribe');
  });

  it('without an OpenAI key it fails with an actionable error', async () => {
    withOpenAi(() => json({}));
    await enableVoice();
    expect(await transcribe()).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_NOT_CONFIGURED' },
    });
  });

  it('maps a rejected key and leaks nothing', async () => {
    withOpenAi(() => json({ error: { message: `bad key ${OPENAI_KEY}` } }, { status: 401 }));
    await addOpenAiKey();
    await enableVoice();
    const result = await transcribe();
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_AUTH_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('SECRETSECRET');
    expect(JSON.stringify(backend.logs.records)).not.toContain('SECRETSECRET');
  });

  it('rejects malformed requests at the IPC boundary', async () => {
    backend = createTestBackend();
    await enableVoice();
    for (const payload of [
      { audio: '', mimeType: 'audio/webm' },
      { audio: AUDIO, mimeType: 'video/mp4' },
      { audio: AUDIO, mimeType: 'audio/webm; codecs=opus; rm -rf' },
      { audio: AUDIO },
      { mimeType: 'audio/webm' },
      { audio: 12, mimeType: 'audio/webm' },
    ]) {
      expect(
        await backend.call('voice:transcribe', payload),
        JSON.stringify(payload).slice(0, 40),
      ).toMatchObject({
        ok: false,
        error: { code: 'INVALID_IPC_PAYLOAD' },
      });
    }
  });

  it('can be stopped by the emergency stop while in flight', async () => {
    withOpenAi(
      (seen) =>
        new Promise<Response>((_, reject) => {
          // Like real fetch: reject as soon as the request is aborted.
          seen.signal?.addEventListener('abort', () => reject(seen.signal!.reason as Error), {
            once: true,
          });
        }),
    );
    await addOpenAiKey();
    await enableVoice();
    const pending = transcribe();
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.container.runs.active().map((r) => r.label)).toEqual(['voice']);
    expect(await backend.call('agent:stop')).toMatchObject({ data: { cancelled: 1 } });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(backend.container.runs.active()).toEqual([]);
  });

  it('never logs or persists what was said or the audio itself', async () => {
    withOpenAi(() => json(transcript('আমার গোপন কথা')));
    await addOpenAiKey();
    await enableVoice();
    await transcribe();
    const logs = JSON.stringify(backend.logs.records);
    expect(logs).not.toContain('আমার গোপন কথা');
    expect(logs).not.toContain(AUDIO.slice(0, 40));
    expect(JSON.stringify(backend.events.events)).not.toContain(AUDIO.slice(0, 40));
  });
});

describe('cloud speech synthesis', () => {
  const mp3 = () => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 5, 6]), { status: 200 });

  it('returns base64 MP3 using the configured voice and model', async () => {
    const seen = withOpenAi(mp3);
    await addOpenAiKey();
    await enableVoice();
    await backend.call('settings:set', { key: 'voice.cloudVoice', value: 'nova' });
    const out = data<{ audio: string; mimeType: string }>(
      await backend.call('voice:synthesize', { text: 'হয়ে গেছে', language: 'bn' }),
    );
    expect(out.mimeType).toBe('audio/mpeg');
    expect(Buffer.from(out.audio, 'base64')[0]).toBe(0xff);
    expect(seen[0]!.url).toContain('/audio/speech');
    expect(seen[0]!.json).toMatchObject({
      voice: 'nova',
      model: 'gpt-4o-mini-tts',
      input: 'হয়ে গেছে',
    });
  });

  it('validates text length and language', async () => {
    withOpenAi(mp3);
    await enableVoice();
    expect(
      await backend.call('voice:synthesize', { text: 'x'.repeat(4001), language: 'en' }),
    ).toMatchObject({ ok: false });
    expect(await backend.call('voice:synthesize', { text: '   ', language: 'en' })).toMatchObject({
      ok: false,
    });
    expect(await backend.call('voice:synthesize', { text: 'hi', language: 'fr' })).toMatchObject({
      ok: false,
    });
  });
});

describe('voice settings validation', () => {
  it('rejects out-of-range and malformed values', async () => {
    backend = createTestBackend();
    for (const [key, value] of [
      ['voice.confidenceThreshold', 0.2],
      ['voice.confidenceThreshold', 0.99],
      ['voice.autoSend', 'yolo'],
      ['voice.speechRate', 5],
      ['voice.cloudVoice', 'alloy"; drop'],
      ['voice.sttModel', 'a b'],
      ['voice.enabled', 'yes'],
    ] as const) {
      expect(
        await backend.call('settings:set', { key, value }),
        `${key}=${String(value)}`,
      ).toMatchObject({ ok: false });
    }
  });
});

const GOOGLE_KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345';
const PCM = Buffer.from(new Uint8Array(200).fill(3)).toString('base64');
const speechAnswer = () =>
  json({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: PCM } }],
        },
      },
    ],
  });

/** The parts of a Google speech request the tests look at. */
interface SpeechRequest {
  contents: Array<{ parts: Array<{ text: string }> }>;
  generationConfig: {
    responseModalities: string[];
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  };
}
interface GoogleSeen {
  url: string;
  key?: string;
  json?: SpeechRequest;
}
/** A backend whose Google endpoints are answered by `respond` (the model list is answered here). */
function withGoogle(
  respond: (seen: GoogleSeen) => Response | Promise<Response> = speechAnswer,
  models: string[] = [
    'gemini-2.5-flash',
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-pro-preview-tts',
  ],
) {
  const seen: GoogleSeen[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes('/models?') || url.endsWith('/models')) {
      return json({
        models: models.map((m) => ({
          name: `models/${m}`,
          supportedGenerationMethods: ['generateContent'],
        })),
      });
    }
    const entry: GoogleSeen = {
      url,
      ...(headers['x-goog-api-key'] ? { key: headers['x-goog-api-key'] } : {}),
    };
    if (typeof init?.body === 'string') entry.json = JSON.parse(init.body);
    seen.push(entry);
    return respond(entry);
  };
  backend = createTestBackend({ fetch: fetchFn });
  return seen;
}
const addGoogleKey = () =>
  backend.call('providers:setKey', { providerId: 'google', apiKey: GOOGLE_KEY });
const useExpressive = async () => {
  await enableVoice();
  await backend.call('settings:set', { key: 'voice.speechEngine', value: 'gemini' });
};
const promptOf = (seen: GoogleSeen) => seen.json!.contents[0]!.parts[0]!.text;

describe('the expressive voice', () => {
  it('is available exactly when a Google key is stored', async () => {
    withGoogle();
    expect(
      data<VoiceCapabilities>(await backend.call('voice:getCapabilities')).expressiveTtsAvailable,
    ).toBe(false);
    await addGoogleKey();
    expect(
      data<VoiceCapabilities>(await backend.call('voice:getCapabilities')).expressiveTtsAvailable,
    ).toBe(true);
  });

  it('speaks with the saved voice, model and style, and returns playable WAV', async () => {
    const seen = withGoogle();
    await addGoogleKey();
    await useExpressive();
    await backend.call('settings:set', { key: 'voice.geminiVoice', value: 'Kore' });
    await backend.call('settings:set', {
      key: 'voice.geminiModel',
      value: 'gemini-2.5-pro-preview-tts',
    });
    await backend.call('settings:set', { key: 'voice.style', value: 'warm and unhurried' });
    const out = data<{ audio: string; mimeType: string }>(
      await backend.call('voice:synthesize', { text: '[whispers] হয়ে গেছে', language: 'bn' }),
    );
    expect(out.mimeType).toBe('audio/wav');
    expect(Buffer.from(out.audio, 'base64').subarray(0, 4).toString()).toBe('RIFF');
    const call = seen.at(-1)!;
    expect(call.url).toContain('/models/gemini-2.5-pro-preview-tts:generateContent');
    expect(call.key).toBe(GOOGLE_KEY);
    expect(call.url).not.toContain(GOOGLE_KEY);
    expect(call.json!.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      'Kore',
    );
    expect(promptOf(call)).toContain('Style: warm and unhurried');
    expect(promptOf(call)).toContain('[whispers] হয়ে গেছে');
    expect(promptOf(call)).toContain('Bengali');
  });

  it('a preview uses the voice and style it is given, without changing what is saved', async () => {
    const seen = withGoogle();
    await addGoogleKey();
    await enableVoice(); // the saved engine is still "system"
    await backend.call('voice:synthesize', {
      text: 'Hi',
      language: 'en',
      engine: 'gemini',
      voice: 'Puck',
      style: 'excited',
    });
    const call = seen.at(-1)!;
    expect(call.json!.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      'Puck',
    );
    expect(promptOf(call)).toContain('Style: excited');
    const settings = data<Record<string, unknown>>(await backend.call('settings:getAll'));
    expect(settings['voice.geminiVoice']).toBe('Sulafat');
    expect(settings['voice.style']).toBe('');
  });

  it('the other cloud voice never reads tags aloud', async () => {
    const seen = withOpenAi(
      () => new Response(new Uint8Array([0xff, 0xfb, 1, 2]), { status: 200 }),
    );
    await addOpenAiKey();
    await enableVoice();
    await backend.call('voice:synthesize', {
      text: '[excited] Great news! [laughs] Really.',
      language: 'en',
    });
    expect((seen[0]!.json as { input: string }).input).toBe('Great news! Really.');
  });

  it('a preview of the other cloud voice also uses the voice it is given', async () => {
    const seen = withOpenAi(
      () => new Response(new Uint8Array([0xff, 0xfb, 1, 2]), { status: 200 }),
    );
    await addOpenAiKey();
    await enableVoice();
    await backend.call('voice:synthesize', {
      text: 'Hi',
      language: 'en',
      engine: 'cloud',
      voice: 'onyx',
    });
    expect(seen[0]!.json).toMatchObject({ voice: 'onyx' });
    await backend.call('voice:synthesize', { text: 'Hi', language: 'en' });
    expect(seen[1]!.json).toMatchObject({ voice: 'alloy' });
  });

  it('is refused until voice is on, with nothing sent', async () => {
    const seen = withGoogle();
    await addGoogleKey();
    expect(
      await backend.call('voice:synthesize', { text: 'Hi', language: 'en', engine: 'gemini' }),
    ).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(seen).toHaveLength(0);
  });

  it('without a Google key it says the provider is not set up, and sends nothing', async () => {
    const seen = withGoogle();
    await useExpressive();
    expect(await backend.call('voice:synthesize', { text: 'Hi', language: 'en' })).toMatchObject({
      ok: false,
    });
    expect(seen).toHaveLength(0);
  });

  it('a failing speech service gives a clean error with no key in it', async () => {
    withGoogle(() => json({ error: { message: `bad ${GOOGLE_KEY}` } }, { status: 500 }));
    await addGoogleKey();
    await useExpressive();
    const result = await backend.call('voice:synthesize', { text: 'Hi', language: 'en' });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(GOOGLE_KEY);
  });

  it('lists the speech models the key can use, and falls back to the default when it cannot', async () => {
    withGoogle();
    expect(
      data<{ models: string[]; fetched: boolean }>(await backend.call('voice:listSpeechModels')),
    ).toEqual({
      models: ['gemini-3.1-flash-tts-preview'],
      fetched: false,
    });
    await addGoogleKey();
    expect(
      data<{ models: string[]; fetched: boolean }>(await backend.call('voice:listSpeechModels')),
    ).toEqual({
      models: ['gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts'],
      fetched: true,
    });
  });

  it('validates what can be chosen', async () => {
    withGoogle();
    for (const [key, value] of [
      ['voice.geminiVoice', 'Kore"; drop'],
      ['voice.geminiVoice', 'K'],
      ['voice.geminiModel', 'a b'],
      ['voice.geminiModel', '../x'],
      ['voice.style', 'x'.repeat(301)],
      ['voice.expressive', 'yes'],
      ['voice.speechEngine', 'elevenlabs'],
    ] as const) {
      expect(
        await backend.call('settings:set', { key, value }),
        `${key}=${String(value)}`,
      ).toMatchObject({ ok: false });
    }
    for (const bad of [
      { voice: 'a b' },
      { voice: '../x' },
      { style: 'x'.repeat(301) },
      { engine: 'system' },
    ]) {
      expect(
        await backend.call('voice:synthesize', { text: 'Hi', language: 'en', ...bad }),
        JSON.stringify(bad),
      ).toMatchObject({ ok: false });
    }
  });
});

describe('choosing the speech-to-text service', () => {
  const heard = (text: string) =>
    json({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify({ text, language: 'en', noSpeech: false }) }] },
        },
      ],
    });

  it('with only a Google key, Google transcribes — and a transcript it is unsure about is reviewed, not sent', async () => {
    const seen = withGoogle(() => heard('open my downloads'));
    await addGoogleKey();
    await enableVoice();
    expect(data<VoiceCapabilities>(await backend.call('voice:getCapabilities'))).toMatchObject({
      sttAvailable: true,
      sttEngine: 'gemini',
    });
    const result = data<TranscriptionResult>(
      await backend.call('voice:transcribe', { audio: AUDIO, mimeType: 'audio/wav' }),
    );
    expect(result).toMatchObject({ text: 'open my downloads', confidence: null });
    expect(result.decision.action).toBe('review');
    expect(seen.at(-1)!.url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(seen.at(-1)!.key).toBe(GOOGLE_KEY);
  });

  it('with both keys, automatic prefers OpenAI; the person can choose Google', async () => {
    const seen: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('/models?') || url.endsWith('/models'))
        return json(
          url.includes('googleapis') ? { models: [] } : { data: [{ id: 'gpt-5', created: 1 }] },
        );
      seen.push(url);
      return url.includes('googleapis') ? heard('from google') : json(transcript('from openai'));
    };
    backend = createTestBackend({ fetch: fetchFn });
    await addOpenAiKey();
    await addGoogleKey();
    await enableVoice();
    expect(data<VoiceCapabilities>(await backend.call('voice:getCapabilities')).sttEngine).toBe(
      'openai',
    );
    await transcribe();
    expect(seen.at(-1)).toContain('/audio/transcriptions');
    await backend.call('settings:set', { key: 'voice.sttEngine', value: 'gemini' });
    expect(data<VoiceCapabilities>(await backend.call('voice:getCapabilities')).sttEngine).toBe(
      'gemini',
    );
    const result = data<TranscriptionResult>(
      await backend.call('voice:transcribe', { audio: AUDIO, mimeType: 'audio/wav' }),
    );
    expect(result.text).toBe('from google');
  });

  it('a chosen service without its key is unavailable, and transcribing says so without sending audio', async () => {
    const seen = withGoogle(() => heard('x'));
    await addGoogleKey();
    await enableVoice();
    await backend.call('settings:set', { key: 'voice.sttEngine', value: 'openai' });
    expect(data<VoiceCapabilities>(await backend.call('voice:getCapabilities'))).toMatchObject({
      sttAvailable: false,
      sttEngine: null,
    });
    expect(await transcribe()).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_NOT_CONFIGURED' },
    });
    expect(seen).toHaveLength(0);
  });
});
