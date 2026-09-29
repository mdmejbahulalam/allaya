import { describe, expect, it } from 'vitest';
import {
  OpenAiCompatibleStt,
  OpenAiCompatibleTts,
  normalizeLanguage,
  parseTranscription,
  MAX_AUDIO_BYTES,
  type AudioEndpoint,
} from '@allaya/voice';
import { AllayaError } from '@allaya/shared';
import { json } from '../../helpers/fetch';

const KEY = 'sk-test-SECRETSECRETSECRET';

interface Recorded {
  url: string;
  method?: string;
  headers: Record<string, string>;
  form?: FormData;
  json?: unknown;
}

function endpoint(
  responder: (req: Recorded, n: number) => Response | Promise<Response>,
  extra: Partial<AudioEndpoint> = {},
) {
  const requests: Recorded[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const req: Recorded = { url, headers, ...(init?.method ? { method: init.method } : {}) };
    if (init?.body instanceof FormData) req.form = init.body;
    else if (typeof init?.body === 'string') req.json = JSON.parse(init.body);
    requests.push(req);
    if (init?.signal?.aborted) throw init.signal.reason;
    return responder(req, requests.length - 1);
  }) as NonNullable<AudioEndpoint['fetch']>;
  const ep: AudioEndpoint = {
    getApiKey: async () => KEY,
    fetch: fetchFn,
    maxRetries: 0,
    backoffMs: 0,
    ...extra,
  };
  return { ep, requests };
}

const audio = (n = 2000) => ({
  bytes: new Uint8Array(n).fill(7),
  mimeType: 'audio/webm;codecs=opus',
});

const bengaliReply = {
  text: ' Downloads folder টা খুলে দাও ',
  language: 'bengali',
  duration: 3.2,
  segments: [
    {
      text: ' Downloads folder টা',
      start: 0,
      end: 1.5,
      avg_logprob: -0.12,
      no_speech_prob: 0.01,
      compression_ratio: 1.1,
    },
    {
      text: ' খুলে দাও',
      start: 1.5,
      end: 3.2,
      avg_logprob: -0.2,
      no_speech_prob: 0.02,
      compression_ratio: 1.0,
    },
  ],
};

describe('OpenAI-compatible speech-to-text', () => {
  it('uploads audio as multipart with the key in the Authorization header only', async () => {
    const { ep, requests } = endpoint(() => json(bengaliReply));
    await new OpenAiCompatibleStt(ep).transcribe(audio(), {
      language: 'bn',
      prompt: 'Allaya, Chrome',
    });

    const req = requests[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(req.method).toBe('POST');
    expect(req.headers['authorization']).toBe(`Bearer ${KEY}`);
    // fetch sets the multipart boundary itself; a hand-set content type would break the upload.
    expect(req.headers['content-type']).toBeUndefined();
    const form = req.form!;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBe('bn');
    expect(form.get('prompt')).toBe('Allaya, Chrome');
    const file = form.get('file') as File;
    expect(file.name).toBe('speech.webm');
    expect(file.size).toBe(2000);
    expect(JSON.stringify([...form.keys()])).not.toContain(KEY);
  });

  it('omits the language hint for "auto" and honours a custom base URL and model', async () => {
    const { ep, requests } = endpoint(() => json(bengaliReply), {
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    await new OpenAiCompatibleStt(ep, 'gpt-4o-transcribe').transcribe(audio(), {
      language: 'auto',
    });
    expect(requests[0]!.url).toBe('http://127.0.0.1:9/v1/audio/transcriptions');
    expect(requests[0]!.form!.has('language')).toBe(false);
    expect(requests[0]!.form!.get('model')).toBe('gpt-4o-transcribe');
  });

  it('parses a Bengali transcription with language and confidence', async () => {
    const { ep } = endpoint(() => json(bengaliReply));
    const result = await new OpenAiCompatibleStt(ep).transcribe(audio(), { language: 'auto' });
    expect(result).toMatchObject({
      text: 'Downloads folder টা খুলে দাও',
      language: 'bn',
      noSpeech: false,
      durationSeconds: 3.2,
    });
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.segments).toHaveLength(2);
  });

  it('reports "no speech" for silence hallucinations instead of returning text', async () => {
    const { ep } = endpoint(() =>
      json({
        text: 'Thanks for watching!',
        language: 'english',
        segments: [
          {
            text: 'Thanks for watching!',
            avg_logprob: -1.4,
            no_speech_prob: 0.85,
            compression_ratio: 0.8,
          },
        ],
      }),
    );
    const result = await new OpenAiCompatibleStt(ep).transcribe(audio(), { language: 'auto' });
    expect(result).toMatchObject({ text: '', noSpeech: true, confidence: null });
  });

  it('gives `confidence: null` — never a made-up number — when the model returns plain text only', async () => {
    const { ep } = endpoint(() => json({ text: 'open chrome' }));
    const result = await new OpenAiCompatibleStt(ep, 'gpt-4o-transcribe').transcribe(audio(), {
      language: 'en',
    });
    expect(result).toMatchObject({
      text: 'open chrome',
      confidence: null,
      language: null,
      noSpeech: false,
    });
  });

  it('refuses empty and oversized audio before any network call', async () => {
    const { ep, requests } = endpoint(() => json(bengaliReply));
    const stt = new OpenAiCompatibleStt(ep);
    await expect(stt.transcribe(audio(0), { language: 'auto' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      stt.transcribe(audio(MAX_AUDIO_BYTES + 1), { language: 'auto' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toHaveLength(0);
  });

  it('maps provider errors to typed, redacted errors', async () => {
    const auth = endpoint(() =>
      json({ error: { message: `Incorrect API key provided: ${KEY}` } }, { status: 401 }),
    );
    const err = await new OpenAiCompatibleStt(auth.ep)
      .transcribe(audio(), { language: 'auto' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllayaError);
    expect(err).toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    expect((err as Error).message).not.toContain('SECRETSECRET');

    const limited = endpoint(() => json({ error: { message: 'slow down' } }, { status: 429 }));
    await expect(
      new OpenAiCompatibleStt(limited.ep).transcribe(audio(), { language: 'auto' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retryable: true,
    });
  });

  it('retries a transient failure and re-sends the whole upload', async () => {
    const { ep, requests } = endpoint(
      (_, n) =>
        n === 0 ? json({ error: { message: 'busy' } }, { status: 503 }) : json(bengaliReply),
      { maxRetries: 2 },
    );
    const result = await new OpenAiCompatibleStt(ep).transcribe(audio(), { language: 'auto' });
    expect(result.text).toContain('Downloads');
    expect(requests).toHaveLength(2);
    expect((requests[1]!.form!.get('file') as File).size).toBe(2000);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    const { ep } = endpoint(
      () =>
        new Promise<Response>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(controller.signal.reason as Error),
            {
              once: true,
            },
          );
        }),
    );
    const pending = new OpenAiCompatibleStt(ep).transcribe(audio(), {
      language: 'auto',
      signal: controller.signal,
    });
    controller.abort(new AllayaError('cancelled', { code: 'CANCELLED' }));
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('surfaces a missing key as PROVIDER_NOT_CONFIGURED without contacting the network', async () => {
    const { ep, requests } = endpoint(() => json(bengaliReply), {
      getApiKey: async () => {
        throw new AllayaError('OpenAI is not configured', { code: 'PROVIDER_NOT_CONFIGURED' });
      },
    });
    await expect(
      new OpenAiCompatibleStt(ep).transcribe(audio(), { language: 'auto' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(requests).toHaveLength(0);
  });

  it('turns an unreadable body into a typed error', async () => {
    const { ep } = endpoint(() => new Response('<html>oops</html>', { status: 200 }));
    await expect(
      new OpenAiCompatibleStt(ep).transcribe(audio(), { language: 'auto' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('transcription parsing helpers', () => {
  it('maps language names to codes', () => {
    expect(normalizeLanguage('bengali')).toBe('bn');
    expect(normalizeLanguage('Bangla')).toBe('bn');
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('hindi')).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
  });

  it('tolerates missing or malformed fields', () => {
    expect(parseTranscription({})).toMatchObject({ text: '', noSpeech: true, confidence: null });
    expect(
      parseTranscription({
        text: 'hello',
        segments: [{ text: 5, avg_logprob: 'x' }],
      }),
    ).toMatchObject({
      text: 'hello',
      confidence: null,
    });
  });
});

describe('OpenAI-compatible text-to-speech', () => {
  const mp3 = () =>
    new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });

  it('requests MP3 with the chosen voice and returns the bytes', async () => {
    const { ep, requests } = endpoint(mp3);
    const out = await new OpenAiCompatibleTts(ep).synthesize('হয়ে গেছে', {
      language: 'bn',
      voice: 'nova',
    });
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(requests[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(requests[0]!.json).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input: 'হয়ে গেছে',
      response_format: 'mp3',
    });
    expect((requests[0]!.json as { instructions: string }).instructions).toMatch(/Bengali/);
    expect(out.mimeType).toBe('audio/mpeg');
    expect(Array.from(out.bytes.slice(0, 2))).toEqual([0xff, 0xfb]);
  });

  it('does not steer English speech and falls back to the default voice', async () => {
    const { ep, requests } = endpoint(mp3);
    await new OpenAiCompatibleTts(ep).synthesize('Done.', { language: 'en' });
    expect(requests[0]!.json).toMatchObject({ voice: 'alloy' });
    expect(requests[0]!.json).not.toHaveProperty('instructions');
  });

  it('rejects empty text and empty audio', async () => {
    const { ep } = endpoint(() => new Response(new Uint8Array(), { status: 200 }));
    const tts = new OpenAiCompatibleTts(ep);
    await expect(tts.synthesize('   ', { language: 'en' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(tts.synthesize('hi', { language: 'en' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('maps auth failures', async () => {
    const { ep } = endpoint(() => json({ error: { message: 'no' } }, { status: 401 }));
    await expect(
      new OpenAiCompatibleTts(ep).synthesize('hi', { language: 'en' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  });
});
