import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '@allaya/ai';
import type { ConnectionView, Settings, VoiceOptions } from '@lite/shared/ipc';
import { json } from '../helpers/fetch';
import { createLiteBackend, data, failure, type LiteBackend } from './helpers/backend';

const OPENAI_KEY = 'sk-proj-VOICEKEYVOICEKEYVOICEKEY1234';
const GOOGLE_KEY = 'AIzaSyVOICEKEYVOICEKEYVOICEKEY123456';
const GROQ_KEY = 'gsk_VOICEKEYVOICEKEYVOICEKEY1234567';
const AUDIO = Buffer.alloc(3000, 7).toString('base64');

const backends: LiteBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
});

interface Seen {
  url: string;
  auth?: string;
  apiKey?: string;
  form?: FormData;
  json?: Record<string, unknown>;
}

/** A fetch that speaks like the speech services do, and remembers what it was asked. */
function speechServices(over: { stt?: () => Response; tts?: () => Response } = {}) {
  const seen: Seen[] = [];
  const pcm = Buffer.alloc(24_000 * 2 * 0.1).toString('base64');
  const fetch: FetchLike = (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const entry: Seen = { url };
    if (headers['authorization']) entry.auth = headers['authorization'];
    if (headers['x-goog-api-key']) entry.apiKey = headers['x-goog-api-key'];
    if (init?.body instanceof FormData) entry.form = init.body;
    else if (typeof init?.body === 'string')
      entry.json = JSON.parse(init.body) as Record<string, unknown>;
    seen.push(entry);
    if (url.endsWith('/models'))
      return Promise.resolve(json({ data: [{ id: 'gpt-5', created: 1 }] }));
    if (url.endsWith('/audio/transcriptions')) {
      return Promise.resolve(
        over.stt?.() ??
          json({
            text: 'Hello Allaya',
            language: 'english',
            duration: 2,
            segments: [
              {
                text: 'Hello Allaya',
                avg_logprob: -0.1,
                no_speech_prob: 0.01,
                compression_ratio: 1.1,
              },
            ],
          }),
      );
    }
    if (url.endsWith('/audio/speech')) {
      return Promise.resolve(
        over.tts?.() ?? new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      );
    }
    if (url.includes(':generateContent')) {
      const parts =
        (
          entry.json?.['contents'] as Array<{
            parts: Array<{ text?: string; inlineData?: unknown }>;
          }>
        )?.[0]?.parts ?? [];
      const wantsAudio = (
        entry.json?.['generationConfig'] as { responseModalities?: string[] } | undefined
      )?.responseModalities?.includes('AUDIO');
      if (wantsAudio) {
        return Promise.resolve(
          json({
            candidates: [
              {
                content: {
                  parts: [
                    { inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } },
                  ],
                },
              },
            ],
          }),
        );
      }
      void parts;
      return Promise.resolve(
        json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      text: 'নমস্কার আলেয়া',
                      language: 'bn',
                      noSpeech: false,
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    }
    return Promise.resolve(json({ error: { message: 'nope' } }, { status: 404 }));
  };
  return { fetch, seen };
}

const boot = (fetch: FetchLike) => {
  const b = createLiteBackend({ fetch });
  backends.push(b);
  return b;
};
const add = async (b: LiteBackend, presetId: string, apiKey: string) =>
  data<ConnectionView>(await b.call('connections:add', { presetId, apiKey }));
const options = async (b: LiteBackend) => data<VoiceOptions>(await b.call('voice:options'));
const setVoice = (b: LiteBackend, voice: Partial<Settings['voice']>) =>
  b.call('settings:set', { voice: { ...b.settings.get().voice, ...voice } });
const transcribe = (b: LiteBackend, mimeType = 'audio/webm;codecs=opus') =>
  b.call('voice:transcribe', { audio: AUDIO, mimeType });

describe('which services can listen and speak', () => {
  it('none when only text services are connected', async () => {
    const b = boot(speechServices().fetch);
    await add(b, 'anthropic', 'sk-ant-api03-VOICEKEYVOICEKEYVOICE');
    await add(b, 'mistral', 'mistral-key-12345678');
    expect(await options(b)).toEqual({ engines: [], stt: null, tts: null });
  });

  it('OpenAI and Google do both, Groq listens, and the first able one is used', async () => {
    const b = boot(speechServices().fetch);
    const groq = await add(b, 'groq', GROQ_KEY);
    const openai = await add(b, 'openai', OPENAI_KEY);
    const google = await add(b, 'google', GOOGLE_KEY);
    const o = await options(b);
    expect(o.engines.map((e) => [e.name, e.stt, e.tts, e.needsWav, e.expressive])).toEqual([
      ['Groq', true, false, false, false],
      ['OpenAI (GPT)', true, true, false, false],
      ['Google (Gemini)', true, true, true, true],
    ]);
    expect(o.engines[2]!.voices.length).toBeGreaterThanOrEqual(30);
    expect(o.engines[1]!.voices.map((v) => v.id)).toContain('alloy');
    expect(o.stt).toEqual({ connectionId: groq.id, needsWav: false });
    await setVoice(b, { sttConnectionId: google.id });
    expect((await options(b)).stt).toEqual({ connectionId: google.id, needsWav: true });
    // A chosen service that is gone falls back to one that works.
    await setVoice(b, { sttConnectionId: 'c_gone' });
    expect((await options(b)).stt?.connectionId).toBe(groq.id);
    expect(openai.id).toBeTruthy();
  });

  it('speaks with this computer’s voice until a service is chosen for it', async () => {
    const b = boot(speechServices().fetch);
    const openai = await add(b, 'openai', OPENAI_KEY);
    expect((await options(b)).tts).toBeNull();
    await setVoice(b, { ttsEngine: 'service' });
    expect((await options(b)).tts).toEqual({
      connectionId: openai.id,
      voice: 'alloy',
      expressive: false,
    });
    await setVoice(b, { ttsVoice: 'nova', ttsConnectionId: openai.id });
    expect((await options(b)).tts?.voice).toBe('nova');
  });

  it('settings saved before the voice options grew a field keep what was saved', async () => {
    const b = boot(speechServices().fetch);
    b.db
      .prepare('insert into settings (key, value) values (?, ?)')
      .run('voice', JSON.stringify({ speakReplies: true }));
    expect(b.settings.get().voice).toMatchObject({
      speakReplies: true,
      ttsEngine: 'system',
      inputLanguage: 'auto',
    });
  });
});

describe('listening', () => {
  it('sends the recording to the service with the key, and returns what was said', async () => {
    const s = speechServices();
    const b = boot(s.fetch);
    await add(b, 'openai', OPENAI_KEY);
    await setVoice(b, { inputLanguage: 'en' });
    const heard = data<{ text: string; language: string | null; noSpeech: boolean }>(
      await transcribe(b),
    );
    expect(heard).toEqual({ text: 'Hello Allaya', language: 'en', noSpeech: false });
    const call = s.seen.find((x) => x.url.endsWith('/audio/transcriptions'))!;
    expect(call.auth).toBe(`Bearer ${OPENAI_KEY}`);
    expect(call.form!.get('model')).toBe('whisper-1');
    expect(call.form!.get('language')).toBe('en');
    expect((call.form!.get('file') as File).size).toBe(3000);
  });

  it('reads Bengali through Gemini, which takes a plain audio file', async () => {
    const s = speechServices();
    const b = boot(s.fetch);
    const google = await add(b, 'google', GOOGLE_KEY);
    await setVoice(b, { sttConnectionId: google.id });
    const heard = data<{ text: string; language: string | null }>(await transcribe(b, 'audio/wav'));
    expect(heard).toMatchObject({ text: 'নমস্কার আলেয়া', language: 'bn' });
    expect(s.seen.find((x) => x.url.includes(':generateContent'))!.apiKey).toBe(GOOGLE_KEY);
  });

  it('says so when nothing was said, instead of returning words that were not spoken', async () => {
    const b = boot(
      speechServices({
        stt: () =>
          json({
            text: 'Thanks for watching!',
            language: 'english',
            duration: 2,
            segments: [
              {
                text: 'Thanks for watching!',
                avg_logprob: -0.9,
                no_speech_prob: 0.95,
                compression_ratio: 1,
              },
            ],
          }),
      }).fetch,
    );
    await add(b, 'openai', OPENAI_KEY);
    expect(data(await transcribe(b))).toMatchObject({ text: '', noSpeech: true });
  });

  it('asks for a service when none can listen, refuses empty or oversized audio, and a bad type', async () => {
    const b = boot(speechServices().fetch);
    expect(failure(await transcribe(b))).toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      details: { reason: 'no_stt' },
    });
    await add(b, 'openai', OPENAI_KEY);
    expect(
      failure(await b.call('voice:transcribe', { audio: '', mimeType: 'audio/wav' })).code,
    ).toBe('INVALID_IPC_PAYLOAD');
    expect(
      failure(await b.call('voice:transcribe', { audio: AUDIO, mimeType: 'text/html' })).code,
    ).toBe('INVALID_IPC_PAYLOAD');
    expect(
      failure(
        await b.call('voice:transcribe', { audio: 'A'.repeat(28_000_001), mimeType: 'audio/wav' }),
      ).code,
    ).toBe('INVALID_IPC_PAYLOAD');
  });

  it('a service that refuses the key says so, and the key is not in what comes back', async () => {
    const b = boot(
      speechServices({
        stt: () => json({ error: { message: `bad key ${OPENAI_KEY}` } }, { status: 401 }),
      }).fetch,
    );
    await add(b, 'openai', OPENAI_KEY);
    const result = await transcribe(b);
    expect(failure(result).code).toBe('PROVIDER_AUTH_FAILED');
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });
});

describe('speaking', () => {
  it('speaks with the chosen service’s voice, without reading tone tags aloud when the voice does not follow them', async () => {
    const s = speechServices();
    const b = boot(s.fetch);
    await add(b, 'openai', OPENAI_KEY);
    await setVoice(b, { ttsEngine: 'service', ttsVoice: 'nova' });
    const out = data<{ audio: string; mimeType: string }>(
      await b.call('voice:synthesize', { text: '[whispers] Hello there', language: 'en' }),
    );
    expect(out.mimeType).toBe('audio/mpeg');
    expect(Buffer.from(out.audio, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
    const call = s.seen.find((x) => x.url.endsWith('/audio/speech'))!;
    expect(call.json).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input: 'Hello there',
    });
    expect(call.auth).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it('Gemini voices are directed in words, and keep the tags that steer them', async () => {
    const s = speechServices();
    const b = boot(s.fetch);
    const google = await add(b, 'google', GOOGLE_KEY);
    await setVoice(b, {
      ttsEngine: 'service',
      ttsConnectionId: google.id,
      ttsVoice: 'Kore',
      ttsStyle: 'warm and unhurried',
    });
    const out = data<{ audio: string; mimeType: string }>(
      await b.call('voice:synthesize', { text: '[warm] আসসালামু আলাইকুম', language: 'bn' }),
    );
    expect(out.mimeType).toBe('audio/wav');
    expect(Buffer.from(out.audio, 'base64').subarray(0, 4).toString()).toBe('RIFF');
    const call = s.seen.find((x) => x.url.includes(':generateContent'))!;
    const sent = JSON.stringify(call.json);
    expect(sent).toContain('warm and unhurried');
    expect(sent).toContain('[warm]');
    expect(sent).toContain('Kore');
  });

  it('can try another service or voice without saving it', async () => {
    const s = speechServices();
    const b = boot(s.fetch);
    await add(b, 'openai', OPENAI_KEY);
    const google = await add(b, 'google', GOOGLE_KEY);
    await b.call('voice:synthesize', {
      text: 'Preview',
      language: 'en',
      connectionId: google.id,
      voice: 'Puck',
      style: 'cheerful',
    });
    expect(JSON.stringify(s.seen.at(-1)!.json)).toContain('Puck');
    expect(b.settings.get().voice).toMatchObject({
      ttsVoice: '',
      ttsStyle: '',
      ttsEngine: 'system',
    });
  });

  it('says what is missing: no service to speak with, or a service with no voice', async () => {
    const b = boot(speechServices().fetch);
    expect(
      failure(await b.call('voice:synthesize', { text: 'Hi', language: 'en' })).details,
    ).toEqual({ reason: 'no_tts' });
    const groq = await add(b, 'groq', GROQ_KEY);
    expect(
      failure(
        await b.call('voice:synthesize', { text: 'Hi', language: 'en', connectionId: groq.id }),
      ).details,
    ).toEqual({ reason: 'no_tts' });
    expect(
      failure(
        await b.call('voice:synthesize', { text: 'Hi', language: 'en', connectionId: 'c_gone' }),
      ).code,
    ).toBe('NOT_FOUND');
    expect(failure(await b.call('voice:synthesize', { text: '   ', language: 'en' })).code).toBe(
      'INVALID_IPC_PAYLOAD',
    );
    expect(
      failure(await b.call('voice:synthesize', { text: 'x'.repeat(4001), language: 'en' })).code,
    ).toBe('INVALID_IPC_PAYLOAD');
  });
});
