import { describe, expect, it } from 'vitest';
import {
  GeminiTts,
  buildSpeechPrompt,
  listSpeechModels,
  pcmToWav,
  readAudio,
  type AudioEndpoint,
} from '@allaya/voice';
import { AllayaError } from '@allaya/shared';
import { json } from '../../helpers/fetch';

const KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345';
const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
const audioBody = (mime = 'audio/L16;codec=pcm;rate=24000', data = pcm) => ({
  candidates: [
    {
      content: {
        parts: [{ inlineData: { mimeType: mime, data: Buffer.from(data).toString('base64') } }],
      },
    },
  ],
});

/** The parts of a Google request these tests look at. */
interface Body {
  contents: Array<{
    parts: Array<{ text: string; inlineData?: { mimeType: string; data: string } }>;
  }>;
  generationConfig: {
    responseModalities: string[];
    responseMimeType: string;
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  };
}
interface Recorded {
  url: string;
  method?: string;
  headers: Record<string, string>;
  json?: Body;
}
function endpoint(responder: (req: Recorded, n: number) => Response | Promise<Response>) {
  const requests: Recorded[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    const req: Recorded = { url, headers, ...(init?.method ? { method: init.method } : {}) };
    if (typeof init?.body === 'string') req.json = JSON.parse(init.body) as Body;
    requests.push(req);
    return responder(req, requests.length - 1);
  }) as NonNullable<AudioEndpoint['fetch']>;
  const ep: AudioEndpoint = {
    getApiKey: async () => KEY,
    fetch: fetchFn,
    maxRetries: 0,
    backoffMs: 0,
  };
  return { ep, requests };
}

describe('pcmToWav', () => {
  it('adds a correct 44-byte header in front of the samples', () => {
    const wav = pcmToWav(pcm, 24000);
    const view = new DataView(wav.buffer);
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 16))).toBe('WAVEfmt ');
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(28, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(String.fromCharCode(...wav.slice(36, 40))).toBe('data');
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect([...wav.slice(44)]).toEqual([...pcm]);
  });
});

describe('readAudio', () => {
  it('wraps raw PCM at the rate the model reports', () => {
    const out = readAudio(audioBody('audio/L16;codec=pcm;rate=16000'))!;
    expect(out.mimeType).toBe('audio/wav');
    expect(new DataView(out.bytes.buffer).getUint32(24, true)).toBe(16000);
  });
  it('passes an already playable container through', () => {
    const out = readAudio(audioBody('audio/mpeg'))!;
    expect(out.mimeType).toBe('audio/mpeg');
    expect([...out.bytes]).toEqual([...pcm]);
  });
  it('is undefined for a text-only answer, an empty part or nothing', () => {
    expect(
      readAudio({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }),
    ).toBeUndefined();
    expect(readAudio(audioBody(undefined, new Uint8Array()))).toBeUndefined();
    expect(readAudio({})).toBeUndefined();
  });
});

describe('the prompt', () => {
  it('puts direction before the transcript, so the direction is not spoken', () => {
    const prompt = buildSpeechPrompt('[whispers] Hello', {
      style: ' warm   and slow ',
      language: 'en',
    });
    expect(prompt.indexOf("DIRECTOR'S NOTES")).toBeLessThan(prompt.indexOf('TRANSCRIPT'));
    expect(prompt).toContain('Style: warm and slow');
    expect(prompt.endsWith('[whispers] Hello')).toBe(true);
  });
  it('asks for Bengali pronunciation when the text is Bengali, and omits an empty style', () => {
    const prompt = buildSpeechPrompt('নমস্কার', { style: '  ', language: 'bn' });
    expect(prompt).toContain('Bengali (Bangladesh)');
    expect(prompt).not.toContain('Style:');
  });
});

describe('GeminiTts', () => {
  it('asks for audio with the chosen voice and model, and the key in a header only', async () => {
    const { ep, requests } = endpoint(() => json(audioBody()));
    const tts = new GeminiTts(ep, { model: 'gemini-x-tts', voice: 'Kore', style: 'calm' });
    const out = await tts.synthesize('[excited] Hi there', { language: 'en' });
    expect(out.mimeType).toBe('audio/wav');
    const req = requests[0]!;
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x-tts:generateContent',
    );
    expect(req.url).not.toContain(KEY);
    expect(req.headers['x-goog-api-key']).toBe(KEY);
    expect(req.json!.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(req.json!.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      'Kore',
    );
    const text = req.json!.contents[0]!.parts[0]!.text;
    expect(text).toContain('Style: calm');
    expect(text).toContain('[excited] Hi there');
    expect(JSON.stringify(req.json)).not.toContain(KEY);
  });

  it('a voice or style given for one call wins over the defaults', async () => {
    const { ep, requests } = endpoint(() => json(audioBody()));
    const tts = new GeminiTts(ep, { voice: 'Kore', style: 'calm' });
    await tts.synthesize('Hi', { language: 'en', voice: 'Puck', style: 'loud' });
    expect(
      requests[0]!.json!.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    ).toBe('Puck');
    expect(requests[0]!.json!.contents[0]!.parts[0]!.text).toContain('Style: loud');
  });

  it('cleans tags before sending, and refuses empty text', async () => {
    const { ep, requests } = endpoint(() => json(audioBody()));
    const tts = new GeminiTts(ep);
    await tts.synthesize('[Calm][calm] Hi', { language: 'en' });
    expect(requests[0]!.json!.contents[0]!.parts[0]!.text.endsWith('\n[calm] Hi')).toBe(true);
    await expect(tts.synthesize('   ', { language: 'en' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(tts.synthesize('[calm]', { language: 'en' })).rejects.toBeInstanceOf(AllayaError);
    expect(requests).toHaveLength(1);
  });

  it('tries once more when the model answers in text, then gives up clearly', async () => {
    const answers = [
      json({ candidates: [{ content: { parts: [{ text: 'I cannot' }] } }] }),
      json(audioBody()),
    ];
    const { ep, requests } = endpoint((_, n) => answers[n]!);
    expect((await new GeminiTts(ep).synthesize('Hi', { language: 'en' })).mimeType).toBe(
      'audio/wav',
    );
    expect(requests).toHaveLength(2);

    const never = endpoint(() => json({ candidates: [{ content: { parts: [{ text: 'no' }] } }] }));
    await expect(
      new GeminiTts(never.ep).synthesize('Hi', { language: 'en' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(never.requests).toHaveLength(2);
  });

  it('reports a blocked prompt without retrying', async () => {
    const { ep, requests } = endpoint(() => json({ promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(new GeminiTts(ep).synthesize('Hi', { language: 'en' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(requests).toHaveLength(1);
  });

  it('a failing service is an error that does not contain the key', async () => {
    const { ep } = endpoint(() => json({ error: { message: `bad key ${KEY}` } }, { status: 400 }));
    const error = await new GeminiTts(ep)
      .synthesize('Hi', { language: 'en' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllayaError);
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(KEY);
  });
});

describe('listSpeechModels', () => {
  it('returns only speech models, with valid names, newest first, across pages', async () => {
    const pages = [
      json({
        models: [
          { name: 'models/gemini-2.5-flash' },
          { name: 'models/gemini-2.5-flash-preview-tts' },
          { name: 'models/gemini-3.1-flash-tts-preview' },
        ],
        nextPageToken: 'p2',
      }),
      json({
        models: [{ name: 'models/gemini-2.5-pro-preview-tts' }, { name: 'models/bad name tts' }],
      }),
    ];
    const { ep, requests } = endpoint((_, n) => pages[n]!);
    expect(await listSpeechModels(ep)).toEqual([
      'gemini-3.1-flash-tts-preview',
      'gemini-2.5-pro-preview-tts',
      'gemini-2.5-flash-preview-tts',
    ]);
    expect(requests[1]!.url).toContain('pageToken=p2');
    expect(requests.every((r) => !r.url.includes(KEY))).toBe(true);
  });
});
