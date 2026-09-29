import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults } from '@allaya/validation';
import type { TranscriptionResult } from '@allaya/validation';
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

/** A recorder whose lifetime the test controls. */
function fakeRecorder() {
  let resolve!: (r: RecordingResult) => void;
  const finished = new Promise<RecordingResult>((r) => (resolve = r));
  const handle: RecorderHandle = {
    finished,
    stop: vi.fn(() =>
      resolve({
        kind: 'audio',
        blob: new Blob([new Uint8Array(1200)], { type: 'audio/webm' }),
        mimeType: 'audio/webm',
        durationMs: 2000,
        speechDetected: true,
      }),
    ),
    cancel: vi.fn(() => resolve({ kind: 'cancelled' })),
  };
  return { handle, resolve };
}

const fakeSpeaker = (): Speaker & { spoken: string[] } => {
  const spoken: string[] = [];
  return { spoken, speak: vi.fn(async (text: string) => void spoken.push(text)), stop: vi.fn() };
};

const decision = (over: Partial<TranscriptionResult> = {}): TranscriptionResult => ({
  text: 'Chrome খুলে দাও',
  language: 'bn',
  confidence: 0.92,
  noSpeech: false,
  decision: { action: 'send', reasons: [] },
  ...over,
});

type Invoke = (channel: string, payload?: unknown) => Promise<unknown>;
let invokeMock: ReturnType<typeof vi.fn<Invoke>>;
let sendMock: ReturnType<typeof vi.fn>;
let recorders: ReturnType<typeof fakeRecorder>[];
let onLevel: ((l: number) => void) | undefined;

function install(
  options: {
    transcribe?: () => Promise<TranscriptionResult>;
    speaker?: Speaker;
    startRecording?: () => Promise<RecorderHandle>;
  } = {},
) {
  recorders = [];
  invokeMock = vi.fn<Invoke>(async (channel) => {
    if (channel === 'voice:transcribe') return (options.transcribe ?? (async () => decision()))();
    if (channel === 'voice:getCapabilities')
      return { enabled: true, sttAvailable: true, cloudTtsAvailable: true };
    throw new Error(`unexpected channel ${channel}`);
  });
  (window as unknown as { allaya: unknown }).allaya = {
    invoke: async (channel: string, payload?: unknown) => {
      try {
        return { ok: true, data: await invokeMock(channel, payload) };
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
        onLevel = o.onLevel;
        const r = fakeRecorder();
        recorders.push(r);
        return r.handle;
      }),
    systemSpeaker: () => options.speaker ?? fakeSpeaker(),
    cloudSpeaker: () => options.speaker ?? fakeSpeaker(),
  });
}

const enable = (over: Partial<typeof settingsDefaults> = {}) =>
  useSettingsStore.setState({
    values: { ...settingsDefaults, 'voice.enabled': true, ...over },
    hydrated: true,
  });
const flush = () => new Promise((r) => setTimeout(r, 0));
const state = () => useVoiceStore.getState().state;

beforeEach(() => {
  resetVoiceForTests();
  sendMock = vi.fn(async () => undefined);
  useChatStore.setState({ send: sendMock as never });
  useUiStore.setState({ route: 'home' });
  enable();
  install();
});
afterEach(() => resetVoiceForTests());

describe('starting to listen', () => {
  it('asks for consent first when voice is off — and does not open the microphone', async () => {
    enable({ 'voice.enabled': false });
    const startRecording = vi.fn();
    install({ startRecording: startRecording as never });
    await useVoiceStore.getState().start();
    expect(useVoiceStore.getState().setupOpen).toBe(true);
    expect(startRecording).not.toHaveBeenCalled();
    expect(state()).toBe('IDLE');
  });

  it('opens the microphone with the chosen device and streams levels to the visualizer', async () => {
    enable({ 'voice.inputDeviceId': 'usb-mic' });
    const startRecording = vi.fn(
      async (o: { deviceId?: string; onLevel?: (l: number) => void }) => {
        onLevel = o.onLevel;
        const r = fakeRecorder();
        recorders.push(r);
        return r.handle;
      },
    );
    install({ startRecording: startRecording as never });
    const started = useVoiceStore.getState().start();
    await flush();
    expect(state()).toBe('LISTENING');
    expect(startRecording.mock.calls[0]![0]).toMatchObject({ deviceId: 'usb-mic' });
    onLevel?.(0.1);
    onLevel?.(0.4);
    expect(useVoiceStore.getState().levels).toEqual([0.1, 0.4]);
    useVoiceStore.getState().interrupt();
    await started;
  });

  it('keeps only the most recent levels', async () => {
    void useVoiceStore.getState().start();
    await flush();
    for (let i = 0; i < 100; i += 1) onLevel?.(i / 100);
    expect(useVoiceStore.getState().levels).toHaveLength(24);
    expect(useVoiceStore.getState().levels.at(-1)).toBe(0.99);
  });
});

describe('from speech to a message', () => {
  it('a confident transcript is sent to the chat and the mic returns to idle', async () => {
    const run = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().finishListening();
    await run;
    await flush();
    expect(invokeMock).toHaveBeenCalledWith(
      'voice:transcribe',
      expect.objectContaining({ mimeType: 'audio/webm' }),
    );
    expect(sendMock).toHaveBeenCalledWith('Chrome খুলে দাও', undefined, 'voice');
    expect(useUiStore.getState().route).toBe('chat');
    expect(state()).toBe('IDLE');
    expect(useVoiceStore.getState().review).toBeNull();
  });

  it('shows PROCESSING while the transcription is in flight', async () => {
    let release!: (r: TranscriptionResult) => void;
    install({ transcribe: () => new Promise((r) => (release = r)) });
    const run = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().finishListening();
    await flush();
    expect(state()).toBe('PROCESSING');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(decision());
    await run;
    await flush();
    expect(state()).toBe('IDLE');
  });

  it('a transcript that needs review is NOT sent; the user can edit and confirm it', async () => {
    install({
      transcribe: async () =>
        decision({
          text: 'report.docx ডিলিট করো',
          confidence: 0.6,
          decision: { action: 'review', reasons: ['destructive', 'low_confidence'] },
        }),
    });
    const run = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().finishListening();
    await run;
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().review).toEqual({
      text: 'report.docx ডিলিট করো',
      confidence: 0.6,
      reasons: ['destructive', 'low_confidence'],
    });

    useVoiceStore.getState().confirmReview('  old-report.docx ডিলিট করো ');
    await flush();
    expect(sendMock).toHaveBeenCalledWith('old-report.docx ডিলিট করো', undefined, 'voice');
    expect(useVoiceStore.getState().review).toBeNull();
  });

  it('dismissing a review sends nothing, and an emptied review is never sent', async () => {
    install({
      transcribe: async () => decision({ decision: { action: 'review', reasons: ['policy'] } }),
    });
    const run = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().finishListening();
    await run;
    await flush();
    useVoiceStore.getState().confirmReview('   ');
    useVoiceStore.getState().dismissReview();
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('silence ("discard") produces a gentle notice and no message', async () => {
    install({
      transcribe: async () =>
        decision({
          text: '',
          noSpeech: true,
          confidence: null,
          decision: { action: 'discard', reasons: [] },
        }),
    });
    const run = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().finishListening();
    await run;
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().notice).toEqual({ kind: 'no_speech' });
  });

  it('no speech detected by the recorder never reaches the server', async () => {
    const run = useVoiceStore.getState().start();
    await flush();
    recorders[0]!.resolve({ kind: 'no_speech' });
    await run;
    await flush();
    expect(invokeMock).not.toHaveBeenCalledWith('voice:transcribe', expect.anything());
    expect(useVoiceStore.getState().notice).toEqual({ kind: 'no_speech' });
    expect(state()).toBe('IDLE');
  });
});

describe('cancelling and stale results', () => {
  it('a transcription that finishes after the user cancelled is dropped — nothing is sent or shown', async () => {
    let release!: (r: TranscriptionResult) => void;
    install({ transcribe: () => new Promise((r) => (release = r)) });
    const run = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().finishListening();
    await flush();
    expect(state()).toBe('PROCESSING');
    useVoiceStore.getState().interrupt();
    expect(state()).toBe('IDLE');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(decision({ text: 'delete everything', decision: { action: 'send', reasons: [] } }));
    await run;
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().review).toBeNull();
    expect(state()).toBe('IDLE');
  });

  it('an old transcription that lands while a NEWER one is processing is dropped, not mistaken for it', async () => {
    const releases: Array<(r: TranscriptionResult) => void> = [];
    install({ transcribe: () => new Promise((r) => releases.push(r)) });
    const first = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().finishListening();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    useVoiceStore.getState().interrupt(); // the user gives up on the first request…
    const second = useVoiceStore.getState().start(); // …and speaks again
    await flush();
    useVoiceStore.getState().finishListening();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(state()).toBe('PROCESSING');

    releases[0]!(decision({ text: 'the OLD request' })); // arrives while the new one is pending
    await first;
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    expect(state()).toBe('PROCESSING'); // still waiting for the new one

    releases[1]!(decision({ text: 'the new request' }));
    await second;
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('the new request', undefined, 'voice');
  });

  it('interrupting while listening releases the microphone immediately', async () => {
    const run = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().interrupt();
    await run;
    expect(recorders[0]!.handle.cancel).toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('voice:transcribe', expect.anything());
    expect(state()).toBe('IDLE');
  });

  it('cancelling while the permission prompt is still open releases the microphone as soon as it is granted', async () => {
    let grant!: (h: RecorderHandle) => void;
    install({ startRecording: () => new Promise<RecorderHandle>((r) => (grant = r)) });
    const run = useVoiceStore.getState().start();
    await flush();
    expect(state()).toBe('LISTENING');
    useVoiceStore.getState().interrupt();
    const late = fakeRecorder();
    grant(late.handle);
    await run;
    expect(late.handle.cancel).toHaveBeenCalled();
    expect(state()).toBe('IDLE');
  });

  it('the mic button toggles: listening → finish, processing → cancel', async () => {
    let release!: (r: TranscriptionResult) => void;
    install({ transcribe: () => new Promise((r) => (release = r)) });
    const run = useVoiceStore.getState().toggle();
    await flush();
    expect(state()).toBe('LISTENING');
    await useVoiceStore.getState().toggle(); // finish
    await flush();
    expect(state()).toBe('PROCESSING');
    await useVoiceStore.getState().toggle(); // cancel
    expect(state()).toBe('IDLE');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(decision());
    await run;
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it.each([
    ['permission_denied', 'mic_permission_denied'],
    ['no_microphone', 'mic_no_microphone'],
    ['unsupported', 'mic_unsupported'],
    ['failed', 'mic_failed'],
  ] as const)(
    'a microphone failure (%s) becomes a specific notice and the next attempt works',
    async (reason, code) => {
      install({
        startRecording: async () => {
          throw new RecorderError(reason);
        },
      });
      await useVoiceStore.getState().start();
      expect(state()).toBe('ERROR');
      expect(useVoiceStore.getState().notice).toEqual({ kind: 'error', code });
      install();
      void useVoiceStore.getState().start();
      await flush();
      expect(state()).toBe('LISTENING');
    },
  );

  it('a backend error while transcribing is reported with its code', async () => {
    install({
      transcribe: async () => {
        throw Object.assign(new Error('nope'), { code: 'PROVIDER_NOT_CONFIGURED' });
      },
    });
    const run = useVoiceStore.getState().start();
    await flush();
    useVoiceStore.getState().finishListening();
    await run;
    await flush();
    expect(state()).toBe('ERROR');
    expect(useVoiceStore.getState().notice).toEqual({
      kind: 'error',
      code: 'PROVIDER_NOT_CONFIGURED',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('speaking', () => {
  it('speaks a cleaned version of the reply and returns to idle', async () => {
    const speaker = fakeSpeaker();
    install({ speaker });
    await useVoiceStore.getState().speak('**Done** — see [the docs](https://example.com)', 'en');
    expect(speaker.spoken).toEqual(['Done — see the docs.']);
    expect(state()).toBe('IDLE');
  });

  it('never talks over the user', async () => {
    const speaker = fakeSpeaker();
    install({ speaker });
    void useVoiceStore.getState().start();
    await flush();
    await useVoiceStore.getState().speak('hello', 'en');
    expect(speaker.speak).not.toHaveBeenCalled();
    expect(state()).toBe('LISTENING');
    useVoiceStore.getState().interrupt();
  });

  it('barge-in: pressing the mic while Allaya is speaking silences it and listens', async () => {
    let finish!: () => void;
    const speaker: Speaker = {
      speak: vi.fn(() => new Promise<void>((r) => (finish = r))),
      stop: vi.fn(),
    };
    install({ speaker });
    const speaking = useVoiceStore.getState().speak('a long reply', 'en');
    await flush();
    expect(state()).toBe('SPEAKING');
    void useVoiceStore.getState().start();
    await flush();
    expect(speaker.stop).toHaveBeenCalled();
    expect(state()).toBe('LISTENING');
    finish(); // the old speech ends late: it must not disturb the new listening session
    await speaking;
    expect(state()).toBe('LISTENING');
    useVoiceStore.getState().interrupt();
  });

  it('the emergency stop silences speech at once', async () => {
    const speaker: Speaker = {
      speak: vi.fn(() => new Promise<void>(() => undefined)),
      stop: vi.fn(),
    };
    install({ speaker });
    void useVoiceStore.getState().speak('a long reply', 'en');
    await flush();
    useVoiceStore.getState().interrupt();
    expect(speaker.stop).toHaveBeenCalled();
    expect(state()).toBe('IDLE');
  });

  it('with no voice installed for the language it says so and stays silent', async () => {
    const speaker: Speaker = {
      speak: vi.fn(async () => {
        throw new SpeechError('no_voice');
      }),
      stop: vi.fn(),
    };
    install({ speaker });
    await useVoiceStore.getState().speak('হয়ে গেছে', 'bn');
    expect(useVoiceStore.getState().notice).toEqual({ kind: 'no_voice', language: 'bn' });
    expect(state()).toBe('IDLE');
  });

  it('a speech failure is a notice, not a broken voice state', async () => {
    const speaker: Speaker = {
      speak: vi.fn(async () => {
        throw new SpeechError('failed');
      }),
      stop: vi.fn(),
    };
    install({ speaker });
    await useVoiceStore.getState().speak('hi', 'en');
    expect(useVoiceStore.getState().notice).toEqual({ kind: 'speech_failed' });
    expect(state()).toBe('IDLE');
  });

  it('does not speak text that is only code or empty after cleaning', async () => {
    const speaker = fakeSpeaker();
    install({ speaker });
    await useVoiceStore.getState().speak('   ', 'en');
    expect(speaker.speak).not.toHaveBeenCalled();
  });
});
