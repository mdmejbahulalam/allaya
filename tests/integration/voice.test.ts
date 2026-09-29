import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptionResult } from '@allaya/validation';
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
      cloudTtsAvailable: false,
    });
  });

  it('reflects consent and the stored OpenAI key', async () => {
    withOpenAi(() => json({}));
    await addOpenAiKey();
    await enableVoice();
    expect(data(await backend.call('voice:getCapabilities'))).toEqual({
      enabled: true,
      sttAvailable: true,
      cloudTtsAvailable: true,
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
