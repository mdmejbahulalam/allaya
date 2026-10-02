import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { settingsDefaults, type MessageView, type TranscriptionResult } from '@allaya/validation';
import { useChatStore } from '@renderer/stores/chat';
import { useSettingsStore } from '@renderer/stores/settings';
import { useUiStore } from '@renderer/stores/ui';
import { configureVoiceRuntime, resetVoiceForTests, useVoiceStore } from '@renderer/stores/voice';
import {
  RecorderError,
  type RecorderHandle,
  type RecordingResult,
} from '@renderer/lib/voice/recorder';
import { SpeechError, type Speaker } from '@renderer/lib/voice/speaker';

// ── fakes ───────────────────────────────────────────────────────────────────
interface FakeRecorder {
  handle: RecorderHandle;
  /** The person says something and stops: the recording ends with audio. */
  say: () => void;
  /** Nobody speaks for the whole round. */
  silence: () => void;
}
const recorders: FakeRecorder[] = [];
const recorderOptions: Array<Record<string, unknown>> = [];

function fakeRecorder(): FakeRecorder {
  let resolve!: (r: RecordingResult) => void;
  const finished = new Promise<RecordingResult>((r) => (resolve = r));
  const audio: RecordingResult = {
    kind: 'audio',
    blob: new Blob([new Uint8Array(1200)], { type: 'audio/webm' }),
    mimeType: 'audio/webm',
    durationMs: 2000,
    speechDetected: true,
  };
  return {
    handle: {
      finished,
      stop: vi.fn(() => resolve(audio)),
      cancel: vi.fn(() => resolve({ kind: 'cancelled' })),
    },
    say: () => resolve(audio),
    silence: () => resolve({ kind: 'no_speech' }),
  };
}

/** A speaker whose speech lasts until the test says it has ended. */
function fakeSpeaker() {
  const pending: Array<{ done: () => void; fail: (e: unknown) => void }> = [];
  const spoken: string[] = [];
  const speaker: Speaker = {
    speak: vi.fn(
      (text: string) =>
        new Promise<void>((done, fail) => {
          spoken.push(text);
          pending.push({ done, fail });
        }),
    ),
    stop: vi.fn(() => pending.splice(0).forEach((p) => p.done())),
  };
  return {
    speaker,
    spoken,
    /** The reply has been heard to the end. */
    finish: () => pending.splice(0).forEach((p) => p.done()),
    breakDown: (e: unknown) => pending.splice(0).forEach((p) => p.fail(e)),
  };
}

const decision = (
  text = 'Chrome খুলে দাও',
  over: Partial<TranscriptionResult> = {},
): TranscriptionResult => ({
  text,
  language: 'bn',
  confidence: 0.92,
  noSpeech: false,
  decision: { action: 'send', reasons: [] },
  ...over,
});

let transcripts: Array<() => Promise<TranscriptionResult>>;
let voice: ReturnType<typeof fakeSpeaker>;
let sendMock: Mock<(text: string, ...rest: unknown[]) => Promise<unknown>>;
let sentTexts: string[];
let nextMessage = 0;

const message = (status: MessageView['status'], content = ''): MessageView => ({
  id: `m${(nextMessage += 1)}`,
  conversationId: 'c1',
  kind: 'assistant',
  content,
  createdAt: 0,
  status,
});

function install(options: { startRecording?: () => Promise<RecorderHandle> } = {}) {
  recorders.length = 0;
  recorderOptions.length = 0;
  voice = fakeSpeaker();
  (window as unknown as { allaya: unknown }).allaya = {
    invoke: async (channel: string) => {
      try {
        if (channel === 'voice:transcribe') {
          const next = transcripts.shift();
          return { ok: true, data: await (next ?? (async () => decision()))() };
        }
        if (channel === 'voice:getCapabilities') {
          return {
            ok: true,
            data: {
              enabled: true,
              sttAvailable: true,
              sttEngine: 'openai',
              cloudTtsAvailable: true,
              expressiveTtsAvailable: true,
            },
          };
        }
        throw new Error(`unexpected channel ${channel}`);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'UNKNOWN';
        return { ok: false, error: { code, message: String(error), retryable: false } };
      }
    },
    subscribe: () => () => undefined,
  };
  configureVoiceRuntime({
    startRecording:
      options.startRecording ??
      (async (o) => {
        recorderOptions.push(o as unknown as Record<string, unknown>);
        const r = fakeRecorder();
        recorders.push(r);
        return r.handle;
      }),
    systemSpeaker: () => voice.speaker,
    cloudSpeaker: () => voice.speaker,
  });
}

const enable = (over: Partial<typeof settingsDefaults> = {}) =>
  useSettingsStore.setState({
    values: { ...settingsDefaults, 'voice.enabled': true, 'voice.conversation': true, ...over },
    hydrated: true,
  });
/** Lets pending work finish, after moving the clock forward by `ms` (a quiet spell, without waiting for it). */
const tick = async (ms = 0) => {
  if (ms > 0) vi.setSystemTime(new Date(Date.now() + ms));
  await new Promise((resolve) => setTimeout(resolve, 60));
};
const real = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const state = () => useVoiceStore.getState().state;
const conversation = () => useVoiceStore.getState().conversation;
const notice = () => useVoiceStore.getState().notice;
const latest = () => recorders.at(-1)!;
/** The microphone button. Listening lasts until the person is done, so the press itself must not be awaited. */
const press = async () => {
  void useVoiceStore.getState().toggle();
  await tick();
};

/** What the voice bridge does when a reply finishes: tell the chat store, then read it aloud. */
const replyArrives = async (
  text = 'ঠিক আছে, খুলছি।',
  status: MessageView['status'] = 'complete',
) => {
  const reply = { ...message(status, text), id: currentReplyId };
  useChatStore.getState().applyFinished(reply);
  if (status === 'complete') await useVoiceStore.getState().speak(text, 'bn');
};
let currentReplyId = '';

beforeEach(() => {
  // Only the clock is faked (for "how long has it been quiet"); the rest runs on real timers, as the browser does.
  vi.useFakeTimers({ toFake: ['Date'] });
  resetVoiceForTests();
  transcripts = [];
  sentTexts = [];
  currentReplyId = '';
  sendMock = vi.fn(async (text: string) => {
    sentTexts.push(text);
    const reply = message('streaming');
    currentReplyId = reply.id;
    return reply;
  });
  useChatStore.setState({
    send: sendMock as never,
    messages: {},
    streaming: {},
    lastCompleted: null,
  });
  useUiStore.setState({ route: 'home' });
  enable();
  install();
});
afterEach(() => {
  resetVoiceForTests();
  vi.useRealTimers();
});

// ── starting and ending ─────────────────────────────────────────────────────
describe('starting and ending a hands-free conversation', () => {
  it('one click on the microphone starts listening and keeps the conversation open', async () => {
    await press();
    expect(conversation()).toBe(true);
    expect(state()).toBe('LISTENING');
  });

  it('with the setting off, one click is a single question, as before', async () => {
    enable({ 'voice.conversation': false });
    await press();
    expect(conversation()).toBe(false);
    expect(state()).toBe('LISTENING');
  });

  it('will not start without consent: it asks for it', async () => {
    enable({ 'voice.enabled': false });
    await press();
    expect(conversation()).toBe(false);
    expect(useVoiceStore.getState().setupOpen).toBe(true);
    expect(recorders).toHaveLength(0);
  });

  it('clicking the microphone during a conversation ends it, and closes the microphone', async () => {
    await press();
    await press();
    expect(conversation()).toBe(false);
    expect(state()).toBe('IDLE');
    expect(latest().handle.cancel).toHaveBeenCalled();
  });

  it.each(['LISTENING', 'PROCESSING', 'SPEAKING', 'waiting for the reply'])(
    'can be ended while %s, and nothing comes back afterwards',
    async (when) => {
      let release!: (r: TranscriptionResult) => void;
      transcripts.push(() => new Promise((r) => (release = r)));
      await press();
      if (when !== 'LISTENING') {
        latest().say();
        await tick();
      }
      if (when === 'SPEAKING' || when === 'waiting for the reply') {
        release(decision());
        await tick();
      }
      if (when === 'SPEAKING') {
        void replyArrives();
        await tick();
      }
      expect(state()).toBe(
        when === 'LISTENING'
          ? 'LISTENING'
          : when === 'PROCESSING'
            ? 'PROCESSING'
            : when === 'SPEAKING'
              ? 'SPEAKING'
              : 'IDLE',
      );

      useVoiceStore.getState().endConversation();
      await tick(10_000);
      expect(conversation()).toBe(false);
      expect(state()).toBe('IDLE');
      expect(recorders.length).toBeLessThanOrEqual(1);
      // A reply that arrives later does not wake the microphone.
      if (currentReplyId)
        useChatStore
          .getState()
          .applyFinished({ ...message('complete', 'late'), id: currentReplyId });
      await tick(10_000);
      expect(state()).toBe('IDLE');
    },
  );

  it('the emergency stop ends a conversation and silences everything', async () => {
    await press();
    useVoiceStore.getState().interrupt();
    await tick(10_000);
    expect(conversation()).toBe(false);
    expect(state()).toBe('IDLE');
    expect(recorders).toHaveLength(1);
  });
});

// ── the loop ────────────────────────────────────────────────────────────────
describe('a conversation goes round: listen, send, wait, speak, listen', () => {
  it('sends what was said, waits for the reply (the microphone stays closed), reads it, then listens again', async () => {
    await press();
    expect(recorders).toHaveLength(1);
    latest().say();
    await tick();
    expect(sentTexts).toEqual(['Chrome খুলে দাও']);
    expect(sendMock).toHaveBeenCalledWith('Chrome খুলে দাও', undefined, 'voice');
    // Waiting for the reply: nobody is listening.
    expect(useVoiceStore.getState().awaitingReply).toBe(true);
    await tick(5000);
    expect(recorders).toHaveLength(1);
    expect(state()).toBe('IDLE');

    // The reply finishes and is read aloud: still not listening (never over Allaya's own voice).
    const speaking = replyArrives('ঠিক আছে, খুলছি।');
    await tick();
    expect(useVoiceStore.getState().awaitingReply).toBe(false);
    expect(state()).toBe('SPEAKING');
    expect(recorders).toHaveLength(1);
    voice.finish();
    await speaking;
    await tick();

    // Heard to the end: the person's turn again.
    expect(recorders).toHaveLength(2);
    expect(state()).toBe('LISTENING');
    expect(conversation()).toBe(true);
  });

  it('goes on for as many turns as the person likes', async () => {
    await press();
    for (let turn = 1; turn <= 4; turn += 1) {
      transcripts.push(async () => decision(`question ${turn}`));
      latest().say();
      await tick();
      const speaking = replyArrives(`answer ${turn}`);
      await tick();
      voice.finish();
      await speaking;
      await tick();
      expect(state()).toBe('LISTENING');
      expect(recorders).toHaveLength(turn + 1);
    }
    expect(sentTexts).toEqual(['question 1', 'question 2', 'question 3', 'question 4']);
    expect(voice.spoken).toEqual(['answer 1.', 'answer 2.', 'answer 3.', 'answer 4.']);
  });

  it('is patient while waiting for the person: it asks the recorder to wait longer than a single question does', async () => {
    await press();
    expect(recorderOptions[0]).toMatchObject({ vad: { noSpeechTimeoutMs: 15_000 } });
    enable({ 'voice.conversation': false });
    resetVoiceForTests();
    install();
    enable({ 'voice.conversation': false });
    await press();
    expect(recorderOptions[0]).not.toHaveProperty('vad');
  });

  it('a reply with nothing to read (only punctuation) goes straight back to listening', async () => {
    await press();
    latest().say();
    await tick();
    await replyArrives('…');
    await tick();
    expect(voice.spoken).toEqual([]);
    expect(recorders).toHaveLength(2);
    expect(state()).toBe('LISTENING');
  });

  it('a reply that is not read at all (voice not asked to speak it) still gives the person their turn', async () => {
    await press();
    latest().say();
    await tick();
    // The bridge does not speak it: the store waits a moment, then listens.
    useChatStore
      .getState()
      .applyFinished({ ...message('complete', 'text only'), id: currentReplyId });
    await real(1000);
    expect(recorders).toHaveLength(1);
    await real(700);
    expect(recorders).toHaveLength(2);
    expect(state()).toBe('LISTENING');
  });

  it('a reply that failed or was cancelled gives the person their turn at once', async () => {
    await press();
    latest().say();
    await tick();
    useChatStore.getState().applyFinished({ ...message('error'), id: currentReplyId });
    await tick();
    expect(recorders).toHaveLength(2);
    expect(state()).toBe('LISTENING');
  });

  it('a reply Allaya wrote itself (already complete when sent) is read, then the person has their turn', async () => {
    sendMock.mockImplementationOnce((text: string) => {
      sentTexts.push(text);
      const reply = message('complete', 'Stopped.');
      useChatStore.setState({ lastCompleted: reply });
      return Promise.resolve(reply);
    });
    await press();
    latest().say();
    await tick();
    const speaking = useVoiceStore.getState().speak('Stopped.', 'en');
    await tick();
    voice.finish();
    await speaking;
    await tick();
    expect(recorders).toHaveLength(2);
  });

  it('never talks over the person: a reply that lands while they are speaking is not read', async () => {
    await press();
    latest().say();
    await tick();
    // The person is already speaking again (the next round) when a late reply arrives.
    useChatStore
      .getState()
      .applyFinished({ ...message('complete', 'late answer'), id: currentReplyId });
    await real(1700);
    expect(state()).toBe('LISTENING');
    await useVoiceStore.getState().speak('some other reply', 'en');
    expect(voice.spoken).toEqual([]);
    expect(state()).toBe('LISTENING');
  });

  it('if the reply cannot be spoken, the conversation carries on (it is on the screen)', async () => {
    await press();
    latest().say();
    await tick();
    const speaking = replyArrives('ঠিক আছে।');
    await tick();
    voice.breakDown(new SpeechError('failed'));
    await speaking;
    await tick();
    expect(notice()).toMatchObject({ kind: 'speech_failed' });
    expect(conversation()).toBe(true);
    expect(recorders).toHaveLength(2);
  });

  it('skip: stops this reply and listens now', async () => {
    await press();
    latest().say();
    await tick();
    void replyArrives('a very long answer');
    await tick();
    expect(state()).toBe('SPEAKING');
    useVoiceStore.getState().skip();
    await tick();
    expect(voice.speaker.stop).toHaveBeenCalled();
    expect(state()).toBe('LISTENING');
    expect(conversation()).toBe(true);
    expect(recorders).toHaveLength(2);
  });

  it('skip does nothing when there is nothing to skip, or no conversation', async () => {
    useVoiceStore.getState().skip();
    expect(state()).toBe('IDLE');
    await press();
    useVoiceStore.getState().skip();
    expect(state()).toBe('LISTENING');
  });
});

// ── quiet ───────────────────────────────────────────────────────────────────
describe('quiet, and when to stop listening', () => {
  it('a round with nobody speaking is not a problem: no message, and it listens again', async () => {
    await press();
    latest().silence();
    await tick();
    expect(notice()).toBeNull();
    expect(recorders).toHaveLength(2);
    expect(state()).toBe('LISTENING');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a transcription that finds only silence is treated the same way', async () => {
    transcripts.push(async () =>
      decision('', { noSpeech: true, text: '', decision: { action: 'discard', reasons: [] } }),
    );
    await press();
    latest().say();
    await tick();
    expect(notice()).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
    expect(recorders).toHaveLength(2);
  });

  it('ends by itself after the chosen time with nobody speaking, says so, and closes the microphone', async () => {
    enable({ 'voice.conversationIdleSeconds': 30 });
    await press();
    latest().silence();
    await tick(10_000);
    expect(conversation()).toBe(true);
    latest().silence();
    await tick(10_000);
    expect(conversation()).toBe(true);
    latest().silence();
    await tick(15_000);
    expect(conversation()).toBe(false);
    expect(notice()).toEqual({ kind: 'conversation_idle' });
    expect(state()).toBe('IDLE');
  });

  it('time spent talking and listening to replies counts: it is only the quiet that ends it', async () => {
    enable({ 'voice.conversationIdleSeconds': 30 });
    await press();
    await tick(25_000);
    latest().say(); // spoke after 25 s
    await tick();
    const speaking = replyArrives('ঠিক আছে।');
    await tick(20_000);
    voice.finish();
    await speaking;
    await tick();
    // 45 s since the start, but only a moment since anyone said or heard anything.
    latest().silence();
    await tick();
    expect(conversation()).toBe(true);
    expect(state()).toBe('LISTENING');
  });
});

// ── safety: the person stays in charge of what is sent ─────────────────────
describe('what is sent in a conversation is checked exactly as before', () => {
  it('an uncertain or risky transcript is shown for review — the conversation waits for the person', async () => {
    transcripts.push(async () =>
      decision('delete everything', {
        confidence: 0.4,
        decision: { action: 'review', reasons: ['destructive', 'low_confidence'] },
      }),
    );
    await press();
    latest().say();
    await tick();
    expect(useVoiceStore.getState().review).toMatchObject({ text: 'delete everything' });
    expect(sendMock).not.toHaveBeenCalled();
    // Nobody is listening while it waits (and it waits as long as it takes).
    await tick(120_000);
    expect(recorders).toHaveLength(1);
    expect(state()).toBe('IDLE');
    expect(conversation()).toBe(true);
  });

  it('once confirmed it is sent, and the conversation carries on from the reply', async () => {
    transcripts.push(async () =>
      decision('open the report', {
        confidence: 0.4,
        decision: { action: 'review', reasons: ['low_confidence'] },
      }),
    );
    await press();
    latest().say();
    await tick();
    useVoiceStore.getState().confirmReview('open the report please');
    await tick();
    expect(sentTexts).toEqual(['open the report please']);
    expect(useVoiceStore.getState().awaitingReply).toBe(true);
    expect(recorders).toHaveLength(1);
  });

  it('dismissed, it goes back to listening', async () => {
    transcripts.push(async () =>
      decision('maybe', {
        confidence: 0.4,
        decision: { action: 'review', reasons: ['low_confidence'] },
      }),
    );
    await press();
    latest().say();
    await tick();
    useVoiceStore.getState().dismissReview();
    await tick();
    expect(sendMock).not.toHaveBeenCalled();
    expect(recorders).toHaveLength(2);
    expect(state()).toBe('LISTENING');
  });
});

// ── failures end it ─────────────────────────────────────────────────────────
describe('when something goes wrong, the conversation ends rather than looping with the microphone open', () => {
  it('a failed transcription', async () => {
    transcripts.push(async () => {
      throw Object.assign(new Error('no key'), { code: 'PROVIDER_NOT_CONFIGURED' });
    });
    await press();
    latest().say();
    await tick();
    expect(conversation()).toBe(false);
    expect(notice()).toMatchObject({ kind: 'error', code: 'PROVIDER_NOT_CONFIGURED' });
    expect(recorders).toHaveLength(1);
  });

  it('a microphone that cannot be opened', async () => {
    install({
      startRecording: async () => {
        throw new RecorderError('permission_denied');
      },
    });
    await press();
    await tick();
    expect(conversation()).toBe(false);
    expect(notice()).toMatchObject({ kind: 'error', code: 'mic_permission_denied' });
  });

  it('a message that could not be sent', async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'UNKNOWN' }));
    await press();
    latest().say();
    await tick();
    expect(conversation()).toBe(false);
    expect(notice()).toMatchObject({ kind: 'error' });
  });
});
