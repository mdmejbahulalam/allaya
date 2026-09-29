import { create } from 'zustand';
import {
  VoiceStateMachine,
  prepareSpeechText,
  type ReviewReason,
  type VoiceEffect,
} from '@allaya/speech';
import type { VoiceState } from '@allaya/types';
import type { VoiceCapabilities } from '@allaya/validation';
import { IpcError, invoke } from '@renderer/lib/api';
import {
  blobToBase64,
  startRecording,
  RecorderError,
  type RecorderHandle,
  type RecorderOptions,
} from '@renderer/lib/voice/recorder';
import {
  CloudSpeaker,
  SpeechError,
  SystemSpeaker,
  type Speaker,
} from '@renderer/lib/voice/speaker';
import { useChatStore } from './chat';
import { useSettingsStore } from './settings';
import { useUiStore } from './ui';

/** Why the last voice attempt did not produce a message. Maps to a localized notice. */
export type VoiceNotice =
  | { kind: 'no_speech' }
  | { kind: 'error'; code: string }
  | { kind: 'no_voice'; language: 'bn' | 'en' }
  | { kind: 'speech_failed' };

export interface VoiceReview {
  text: string;
  confidence: number | null;
  reasons: ReviewReason[];
}

interface VoiceStoreState {
  state: VoiceState;
  /** Latest microphone levels (0..1), newest last — drives the visualizer. */
  levels: number[];
  review: VoiceReview | null;
  notice: VoiceNotice | null;
  capabilities: VoiceCapabilities | null;
  setupOpen: boolean;
  refreshCapabilities: () => Promise<void>;
  openSetup: (open: boolean) => void;
  /** Mic button: start listening, or finish listening / stop speaking. */
  toggle: () => Promise<void>;
  start: () => Promise<void>;
  /** Finish the current recording and transcribe it. */
  finishListening: () => void;
  /** Cancel whatever voice is doing (listening, transcribing, speaking). The emergency stop calls this. */
  interrupt: () => void;
  speak: (text: string, language: 'bn' | 'en') => Promise<void>;
  confirmReview: (text: string) => void;
  dismissReview: () => void;
  dismissNotice: () => void;
}

/** Everything that touches real hardware, injectable so the flow can be tested with fakes. */
export interface VoiceRuntime {
  startRecording: (options: RecorderOptions) => Promise<RecorderHandle>;
  systemSpeaker: () => Speaker;
  cloudSpeaker: () => Speaker;
}

const defaultRuntime: VoiceRuntime = {
  startRecording,
  systemSpeaker: () =>
    new SystemSpeaker({
      getRate: () => useSettingsStore.getState().values['voice.speechRate'],
      getVoiceUri: () => useSettingsStore.getState().values['voice.systemVoice'],
    }),
  cloudSpeaker: () => new CloudSpeaker(),
};

let runtime: VoiceRuntime = defaultRuntime;
export function configureVoiceRuntime(next: VoiceRuntime | undefined): void {
  runtime = next ?? defaultRuntime;
  speakers.clear();
}

const speakers = new Map<'system' | 'cloud', Speaker>();
const speakerFor = (engine: 'system' | 'cloud'): Speaker => {
  let speaker = speakers.get(engine);
  if (!speaker) {
    speaker = engine === 'cloud' ? runtime.cloudSpeaker() : runtime.systemSpeaker();
    speakers.set(engine, speaker);
  }
  return speaker;
};

const LEVEL_BARS = 24;
const machine = new VoiceStateMachine();
let recorder: RecorderHandle | undefined;
let activeSpeaker: Speaker | undefined;

const settings = () => useSettingsStore.getState().values;

export const useVoiceStore = create<VoiceStoreState>((set, get) => {
  /** Applies a transition's side effects. The machine decides *what*; this decides *how*. */
  const run = (effects: VoiceEffect[]) => {
    for (const effect of effects) {
      if (effect === 'close_microphone') {
        recorder?.cancel();
        recorder = undefined;
      } else if (effect === 'stop_speech') {
        activeSpeaker?.stop();
        activeSpeaker = undefined;
      }
      // 'open_microphone', 'begin_transcription' and 'begin_speech' are driven by the async flows below.
    }
  };
  const sync = () => set({ state: machine.state });
  const fail = (epoch: number, notice: VoiceNotice) => {
    const result = machine.dispatch({ type: 'fail', epoch, message: notice.kind });
    if (result.ok) run(result.effects);
    set({ state: machine.state, notice, levels: [] });
  };

  const transcribe = async (epoch: number, blob: Blob, mimeType: string) => {
    try {
      const audio = await blobToBase64(blob);
      const result = await invoke('voice:transcribe', { audio, mimeType });
      // The user may have cancelled or started over while we waited: a stale result is dropped, never acted on.
      const done = machine.dispatch({ type: 'transcribed', epoch });
      if (!done.ok) return;
      sync();
      set({ levels: [] });
      const { action, reasons } = result.decision;
      if (action === 'discard') set({ notice: { kind: 'no_speech' } });
      else if (action === 'review')
        set({ review: { text: result.text, confidence: result.confidence, reasons } });
      else await submit(result.text);
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'UNKNOWN';
      fail(epoch, { kind: 'error', code });
    }
  };

  const submit = async (text: string) => {
    useUiStore.getState().navigate('chat');
    try {
      await useChatStore.getState().send(text);
    } catch (error) {
      set({ notice: { kind: 'error', code: error instanceof IpcError ? error.code : 'UNKNOWN' } });
    }
  };

  const beginListening = async () => {
    const started = machine.dispatch({ type: 'start_listening' });
    if (!started.ok) return;
    run(started.effects);
    const epoch = started.snapshot.epoch;
    set({ state: machine.state, review: null, notice: null, levels: [] });

    let handle: RecorderHandle;
    try {
      handle = await runtime.startRecording({
        deviceId: settings()['voice.inputDeviceId'],
        onLevel: (level) => {
          if (machine.snapshot.epoch !== epoch) return;
          set((s) => ({ levels: [...s.levels, level].slice(-LEVEL_BARS) }));
        },
      });
    } catch (error) {
      const reason = error instanceof RecorderError ? error.reason : 'failed';
      fail(epoch, { kind: 'error', code: `mic_${reason}` });
      return;
    }
    // Permission prompts take time; if the user cancelled meanwhile, release the microphone immediately.
    if (machine.snapshot.epoch !== epoch || machine.state !== 'LISTENING') {
      handle.cancel();
      return;
    }
    recorder = handle;

    const result = await handle.finished;
    if (recorder === handle) recorder = undefined;
    if (machine.snapshot.epoch !== epoch) return; // interrupted or superseded
    if (result.kind === 'audio') {
      const next = machine.dispatch({ type: 'stop_listening' });
      if (!next.ok) return;
      sync();
      await transcribe(epoch, result.blob, result.mimeType);
    } else {
      const idle = machine.dispatch({ type: 'interrupt' });
      if (idle.ok) run(idle.effects);
      set({
        state: machine.state,
        levels: [],
        notice: result.kind === 'no_speech' ? { kind: 'no_speech' } : null,
      });
    }
  };

  return {
    state: 'IDLE',
    levels: [],
    review: null,
    notice: null,
    capabilities: null,
    setupOpen: false,

    async refreshCapabilities() {
      try {
        set({ capabilities: await invoke('voice:getCapabilities') });
      } catch {
        set({ capabilities: null });
      }
    },

    openSetup: (open) => set({ setupOpen: open }),

    async toggle() {
      const { state } = get();
      if (state === 'LISTENING') return get().finishListening();
      if (state === 'SPEAKING' || state === 'PROCESSING') return get().interrupt();
      return get().start();
    },

    async start() {
      if (!settings()['voice.enabled']) {
        set({ setupOpen: true });
        return;
      }
      await beginListening();
    },

    finishListening() {
      recorder?.stop();
    },

    interrupt() {
      const result = machine.dispatch({ type: 'interrupt' });
      if (result.ok) run(result.effects);
      set({ state: machine.state, levels: [] });
    },

    async speak(text, language) {
      const engine = settings()['voice.speechEngine'];
      const spoken = prepareSpeechText(text, {
        linkWord: language === 'bn' ? 'লিংক' : 'link',
        codeWord: language === 'bn' ? 'কোড' : 'code',
      });
      if (!spoken) return;
      const started = machine.dispatch({ type: 'start_speaking' });
      if (!started.ok) return; // busy listening/processing: never talk over the user
      const epoch = started.snapshot.epoch;
      set({ state: machine.state });
      const speaker = speakerFor(engine);
      activeSpeaker = speaker;
      try {
        await speaker.speak(spoken, language);
        const done = machine.dispatch({ type: 'finished_speaking', epoch });
        if (done.ok) sync();
      } catch (error) {
        if (machine.snapshot.epoch !== epoch) return;
        const idle = machine.dispatch({ type: 'interrupt' });
        if (idle.ok) run(idle.effects);
        set({
          state: machine.state,
          notice:
            error instanceof SpeechError && error.reason === 'no_voice'
              ? { kind: 'no_voice', language }
              : { kind: 'speech_failed' },
        });
      } finally {
        if (activeSpeaker === speaker && machine.state !== 'SPEAKING') activeSpeaker = undefined;
      }
    },

    confirmReview(text) {
      const trimmed = text.trim();
      set({ review: null });
      if (trimmed) void submit(trimmed);
    },
    dismissReview: () => set({ review: null }),
    dismissNotice: () => set({ notice: null }),
  };
});

/** For tests: releases any hardware and returns to a pristine idle machine with the default runtime. */
export function resetVoiceForTests(): void {
  useVoiceStore.getState().interrupt();
  machine.dispatch({ type: 'reset' });
  recorder = undefined;
  activeSpeaker = undefined;
  configureVoiceRuntime(undefined);
  useVoiceStore.setState({
    state: 'IDLE',
    levels: [],
    review: null,
    notice: null,
    capabilities: null,
    setupOpen: false,
  });
}

export const isVoiceActive = (state: VoiceState) =>
  state === 'LISTENING' || state === 'PROCESSING' || state === 'SPEAKING';
