import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceOptions } from '@lite/shared/ipc';
import {
  RecorderError,
  type RecorderHandle,
  type RecordingResult,
} from '@lite/renderer/src/lib/voice/recorder';
import { SpeechError, type Speaker } from '@lite/renderer/src/lib/voice/speaker';
import { useChatStore } from '@lite/renderer/src/stores/chat';
import {
  CONVERSATION_IDLE_MS,
  pendingWaits,
  resetVoiceForTests,
  setVoiceRuntime,
  useVoiceStore,
} from '@lite/renderer/src/stores/voice';
import { bridge, fail, message, resetStores } from './helpers';

const tick = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const state = () => useVoiceStore.getState();

const options = (over: Partial<VoiceOptions> = {}): VoiceOptions => ({
  engines: [],
  stt: { connectionId: 'c1', needsWav: false },
  tts: null,
  ...over,
});

const audio = (): RecordingResult => ({
  kind: 'audio',
  blob: new Blob([new Uint8Array(100)], { type: 'audio/webm' }),
  mimeType: 'audio/webm',
  durationMs: 1500,
  speechDetected: true,
});

/** A microphone the test controls: each listening round is a handle that the test finishes. */
function microphone() {
  const rounds: Array<{
    finish: (r: RecordingResult) => void;
    cancelled: boolean;
    options: unknown;
  }> = [];
  const startRecording = vi.fn((opts: unknown) => {
    let finish!: (r: RecordingResult) => void;
    const finished = new Promise<RecordingResult>((resolve) => {
      finish = resolve;
    });
    const round = { finish, cancelled: false, options: opts };
    rounds.push(round);
    const handle: RecorderHandle = {
      finished,
      stop: () => finish(audio()),
      cancel: () => {
        round.cancelled = true;
        finish({ kind: 'cancelled' });
      },
    };
    return Promise.resolve(handle);
  });
  return { rounds, startRecording: startRecording as never };
}

/** Speakers that record what they were asked to say, and finish when the test says (or when stopped). */
function speakers(over: { failWith?: SpeechError; holdOpen?: boolean } = {}) {
  const said: Array<{ text: string; language: string }> = [];
  const made: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const makeSpeaker = (): Speaker => {
    let release: () => void = () => undefined;
    const stop = vi.fn(() => release());
    made.push({ stop });
    return {
      speak: (text, language) => {
        said.push({ text, language });
        if (over.failWith) return Promise.reject(over.failWith);
        if (!over.holdOpen) return Promise.resolve();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      stop,
    };
  };
  return { said, made, makeSpeaker };
}

/** The chat as the voice loop sees it: sending adds the person's message and a reply that is being written. */
function chat() {
  const sent: string[] = [];
  let n = 0;
  useChatStore.setState({
    send: (text: string) => {
      sent.push(text);
      n += 1;
      useChatStore.setState((s) => ({
        activeId: 'chat1',
        messages: [
          ...s.messages,
          message({ id: `u${n}`, role: 'user', content: text }),
          message({ id: `r${n}`, status: 'streaming' }),
        ],
      }));
      return Promise.resolve();
    },
  });
  const finishReply = (content: string, status: 'complete' | 'error' | 'cancelled' = 'complete') =>
    useChatStore.setState((s) => ({
      messages: s.messages.map((m) => (m.id === `r${n}` ? { ...m, content, status } : m)),
    }));
  return { sent, finishReply };
}

let transcribed: Array<{ audio: string; mimeType: string }>;
const hears =
  (text: string, noSpeech = false) =>
  () => ({ text, language: 'en', noSpeech });

beforeEach(() => {
  resetStores();
  resetVoiceForTests();
  transcribed = [];
});

const heardBy = (reply: (p: { audio: string; mimeType: string }) => unknown) =>
  bridge({
    'voice:options': () => options(),
    'voice:transcribe': (p) => {
      transcribed.push(p as never);
      return reply(p as never);
    },
  });

describe('starting a conversation', () => {
  it('asks to set up a service that can listen when there is none, and never opens the microphone', async () => {
    bridge({ 'voice:options': () => options({ stt: null }) });
    const mic = microphone();
    setVoiceRuntime({ startRecording: mic.startRecording });
    await state().toggle();
    expect(state()).toMatchObject({ active: false, state: 'idle', notice: { kind: 'no_stt' } });
    expect(mic.rounds).toHaveLength(0);
  });

  it('explains a microphone that is blocked, missing or cannot start', async () => {
    bridge({ 'voice:options': () => options() });
    for (const reason of ['permission_denied', 'no_microphone', 'unsupported'] as const) {
      setVoiceRuntime({
        startRecording: () => Promise.reject(new RecorderError(reason)),
      });
      await state().toggle();
      expect(state()).toMatchObject({ active: false, notice: { kind: 'mic', reason } });
    }
  });

  it('explains when the engine could not even say what is available', async () => {
    bridge({
      'voice:options': () => {
        throw fail('INTERNAL');
      },
    });
    await state().toggle();
    expect(state()).toMatchObject({ active: false, notice: { kind: 'error', code: 'INTERNAL' } });
  });

  it('a second press ends the conversation and the microphone is let go', async () => {
    heardBy(hears('x'));
    const mic = microphone();
    setVoiceRuntime({ startRecording: mic.startRecording });
    void state().toggle();
    await tick();
    expect(state()).toMatchObject({ active: true, state: 'listening' });
    await state().toggle();
    expect(state()).toMatchObject({ active: false, state: 'idle', notice: null });
    expect(mic.rounds[0]!.cancelled).toBe(true);
  });
});

describe('a conversation', () => {
  it('listens, understands, sends, waits for the reply, reads it aloud, and listens again', async () => {
    heardBy(hears('What is the time?'));
    const mic = microphone();
    const voice = speakers();
    const c = chat();
    setVoiceRuntime({ startRecording: mic.startRecording, makeSpeaker: voice.makeSpeaker });
    void state().toggle();
    await tick();
    expect(state().state).toBe('listening');
    expect(mic.rounds[0]!.options).toMatchObject({ autoStop: true });

    mic.rounds[0]!.finish(audio());
    await tick();
    expect(transcribed).toHaveLength(1);
    expect(transcribed[0]!.mimeType).toBe('audio/webm');
    expect(c.sent).toEqual(['What is the time?']);
    expect(state().state).toBe('thinking');

    c.finishReply('It is **noon**. See https://example.com');
    await tick();
    // The written reply is cleaned for the ear: no stars, no web address read letter by letter.
    expect(voice.said).toEqual([{ text: 'It is noon. See link.', language: 'en' }]);
    expect(mic.rounds).toHaveLength(2);
    expect(state()).toMatchObject({ active: true, state: 'listening' });
  });

  it('reads a Bengali reply in Bengali', async () => {
    heardBy(hears('সময় কত?'));
    const mic = microphone();
    const voice = speakers();
    const c = chat();
    setVoiceRuntime({ startRecording: mic.startRecording, makeSpeaker: voice.makeSpeaker });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    c.finishReply('এখন দুপুর বারোটা।');
    await tick();
    expect(voice.said).toEqual([{ text: 'এখন দুপুর বারোটা।', language: 'bn' }]);
  });

  it('keeps listening through quiet, and ends by itself after a long silence', async () => {
    heardBy(hears('x'));
    const mic = microphone();
    let now = 1_000;
    setVoiceRuntime({ startRecording: mic.startRecording, now: () => now });
    void state().toggle();
    await tick();
    now += 30_000;
    mic.rounds[0]!.finish({ kind: 'no_speech' });
    await tick();
    expect(state()).toMatchObject({ active: true, state: 'listening' });
    expect(mic.rounds).toHaveLength(2);
    now += CONVERSATION_IDLE_MS;
    mic.rounds[1]!.finish({ kind: 'no_speech' });
    await tick();
    expect(state()).toMatchObject({ active: false, notice: { kind: 'idle' } });
  });

  it('what turns out to be no speech is not sent', async () => {
    heardBy(hears('', true));
    const mic = microphone();
    const c = chat();
    setVoiceRuntime({ startRecording: mic.startRecording });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    expect(c.sent).toEqual([]);
    expect(mic.rounds).toHaveLength(2);
  });

  it('a service that needs a plain audio file is given one', async () => {
    bridge({
      'voice:options': () => options({ stt: { connectionId: 'g', needsWav: true } }),
      'voice:transcribe': (p) => (
        transcribed.push(p as never),
        { text: 'hi', language: 'en', noSpeech: false }
      ),
    });
    const mic = microphone();
    chat();
    const toWav = vi.fn(() =>
      Promise.resolve(new Blob([new Uint8Array(10)], { type: 'audio/wav' })),
    );
    setVoiceRuntime({ startRecording: mic.startRecording, toWav });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    expect(toWav).toHaveBeenCalledTimes(1);
    expect(transcribed[0]!.mimeType).toBe('audio/wav');
  });

  it('a failure to understand ends the conversation and says why', async () => {
    heardBy(() => {
      throw fail('PROVIDER_AUTH_FAILED');
    });
    const mic = microphone();
    setVoiceRuntime({ startRecording: mic.startRecording });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    expect(state()).toMatchObject({
      active: false,
      notice: { kind: 'error', code: 'PROVIDER_AUTH_FAILED' },
    });
  });

  it('with no listening service chosen, says so when the first recording is sent', async () => {
    heardBy(() => {
      throw fail('PROVIDER_NOT_CONFIGURED', 'x', { reason: 'no_stt' });
    });
    const mic = microphone();
    setVoiceRuntime({ startRecording: mic.startRecording });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    expect(state().notice).toEqual({ kind: 'no_stt' });
  });

  it('a message that cannot be sent ends it; a reply that fails or is stopped ends it quietly', async () => {
    heardBy(hears('Hello'));
    const mic = microphone();
    setVoiceRuntime({ startRecording: mic.startRecording });
    useChatStore.setState({ send: () => Promise.reject(fail('PROVIDER_NOT_CONFIGURED')) });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    expect(state()).toMatchObject({
      active: false,
      notice: { kind: 'error', code: 'PROVIDER_NOT_CONFIGURED' },
    });

    resetVoiceForTests();
    const second = microphone();
    const c = chat();
    setVoiceRuntime({ startRecording: second.startRecording });
    void state().toggle();
    await tick();
    second.rounds[0]!.finish(audio());
    await tick();
    c.finishReply('', 'error');
    await tick();
    expect(state()).toMatchObject({ active: false, notice: null });
  });

  it('can be ended while the reply is still being written, and then nothing is spoken', async () => {
    heardBy(hears('Hello'));
    const mic = microphone();
    const voice = speakers();
    const c = chat();
    setVoiceRuntime({ startRecording: mic.startRecording, makeSpeaker: voice.makeSpeaker });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    expect(pendingWaits()).toBe(1);
    state().end();
    // Ending lets go of everything that was waiting for the reply, even if the reply never changes.
    expect(pendingWaits()).toBe(0);
    c.finishReply('A late answer');
    await tick();
    expect(voice.said).toEqual([]);
    expect(mic.rounds).toHaveLength(1);
    expect(state().active).toBe(false);
  });

  it('can be ended or skipped while it is speaking', async () => {
    heardBy(hears('Hello'));
    const mic = microphone();
    const voice = speakers({ holdOpen: true });
    const c = chat();
    setVoiceRuntime({ startRecording: mic.startRecording, makeSpeaker: voice.makeSpeaker });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    c.finishReply('A long answer');
    await tick();
    expect(state().state).toBe('speaking');
    // Skip: the reading stops and the microphone opens again.
    state().skip();
    await tick();
    expect(voice.made[0]!.stop).toHaveBeenCalled();
    expect(state()).toMatchObject({ active: true, state: 'listening' });
    expect(mic.rounds).toHaveLength(2);
    // End while listening again.
    state().end();
    expect(mic.rounds[1]!.cancelled).toBe(true);
  });

  it('ending while it speaks stops the voice at once', async () => {
    heardBy(hears('Hello'));
    const mic = microphone();
    const voice = speakers({ holdOpen: true });
    const c = chat();
    setVoiceRuntime({ startRecording: mic.startRecording, makeSpeaker: voice.makeSpeaker });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    c.finishReply('Answer');
    await tick();
    state().end();
    await tick();
    expect(voice.made[0]!.stop).toHaveBeenCalled();
    expect(mic.rounds).toHaveLength(1);
    expect(state()).toMatchObject({ active: false, state: 'idle' });
  });

  it('a voice that cannot speak does not end the conversation: the reply is on the screen', async () => {
    heardBy(hears('Hello'));
    const mic = microphone();
    const voice = speakers({ failWith: new SpeechError('no_voice') });
    const c = chat();
    setVoiceRuntime({ startRecording: mic.startRecording, makeSpeaker: voice.makeSpeaker });
    void state().toggle();
    await tick();
    mic.rounds[0]!.finish(audio());
    await tick();
    c.finishReply('Answer');
    await tick();
    expect(state()).toMatchObject({
      active: true,
      state: 'listening',
      notice: { kind: 'no_voice' },
    });
    expect(mic.rounds).toHaveLength(2);
  });
});

describe('reading a single reply aloud', () => {
  it('speaks it, can be stopped, and does nothing during a conversation', async () => {
    bridge({ 'voice:options': () => options() });
    const voice = speakers({ holdOpen: true });
    setVoiceRuntime({ makeSpeaker: voice.makeSpeaker });
    const speaking = state().speakText('Hello there');
    await tick();
    expect(voice.said).toEqual([{ text: 'Hello there.', language: 'en' }]);
    expect(state().speakingAloud).toBe(true);
    state().stopSpeaking();
    await speaking;
    expect(state().speakingAloud).toBe(false);
    expect(voice.made[0]!.stop).toHaveBeenCalled();

    useVoiceStore.setState({ active: true });
    await state().speakText('Not now');
    expect(voice.said).toHaveLength(1);
  });

  it('says so when this computer has no voice for the language', async () => {
    bridge({ 'voice:options': () => options() });
    setVoiceRuntime({
      makeSpeaker: speakers({ failWith: new SpeechError('no_voice') }).makeSpeaker,
    });
    await state().speakText('আসসালামু আলাইকুম');
    expect(state().notice).toEqual({ kind: 'no_voice' });
  });

  it('reads nothing that is only code or empty after cleaning', async () => {
    bridge({ 'voice:options': () => options() });
    const voice = speakers();
    setVoiceRuntime({ makeSpeaker: voice.makeSpeaker });
    await state().speakText('   ');
    expect(voice.said).toEqual([]);
  });
});
