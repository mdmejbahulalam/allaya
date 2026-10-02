import { create } from 'zustand';
import {
  VoiceStateMachine,
  cleanAudioTags,
  prepareSpeechText,
  stripAudioTags,
  type ReviewReason,
  type VoiceEffect,
} from '@allaya/speech';
import type { VoiceState } from '@allaya/types';
import type { VoiceCapabilities } from '@allaya/validation';
import { IpcError, invoke } from '@renderer/lib/api';
import { recordingToWav } from '@renderer/lib/voice/wav';
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
  | { kind: 'speech_failed' }
  /** A hands-free conversation ended by itself because nobody spoke for a while. */
  | { kind: 'conversation_idle' };

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
  /** Hands-free: the microphone keeps coming back after each reply, until the person ends it. */
  conversation: boolean;
  /** In a conversation: a message has been sent and its reply has not finished yet. */
  awaitingReply: boolean;
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
  /** Starts a hands-free conversation (the mic button does this when the setting is on). */
  startConversation: () => Promise<void>;
  /** Ends it: closes the microphone and silences speech. The person's own "stop". */
  endConversation: (notice?: VoiceNotice) => void;
  /** In a conversation: stop speaking this reply and listen now. */
  skip: () => void;
  speak: (text: string, language: 'bn' | 'en') => Promise<void>;
  confirmReview: (text: string) => void;
  dismissReview: () => void;
  dismissNotice: () => void;
}

/** Everything that touches real hardware, injectable so the flow can be tested with fakes. */
export interface VoiceRuntime {
  startRecording: (options: RecorderOptions) => Promise<RecorderHandle>;
  /** Re-encodes a recording as WAV for services that do not read what the browser records. */
  toWav?: (blob: Blob) => Promise<Blob>;
  systemSpeaker: () => Speaker;
  cloudSpeaker: () => Speaker;
  /** The expressive (tone-tag) voice. Tests that do not care may leave it out. */
  expressiveSpeaker?: () => Speaker;
}

const defaultRuntime: VoiceRuntime = {
  startRecording,
  toWav: recordingToWav,
  systemSpeaker: () =>
    new SystemSpeaker({
      getRate: () => useSettingsStore.getState().values['voice.speechRate'],
      getVoiceUri: () => useSettingsStore.getState().values['voice.systemVoice'],
    }),
  cloudSpeaker: () => new CloudSpeaker(),
  expressiveSpeaker: () => new CloudSpeaker({ engine: 'gemini', chunkChars: 420 }),
};

let runtime: VoiceRuntime = defaultRuntime;
export function configureVoiceRuntime(next: VoiceRuntime | undefined): void {
  runtime = next ?? defaultRuntime;
  speakers.clear();
}

type Engine = 'system' | 'cloud' | 'gemini';
const speakers = new Map<Engine, Speaker>();
const speakerFor = (engine: Engine): Speaker => {
  let speaker = speakers.get(engine);
  if (!speaker) {
    speaker =
      engine === 'gemini'
        ? (runtime.expressiveSpeaker ?? runtime.cloudSpeaker)()
        : engine === 'cloud'
          ? runtime.cloudSpeaker()
          : runtime.systemSpeaker();
    speakers.set(engine, speaker);
  }
  return speaker;
};

const LEVEL_BARS = 24;
const machine = new VoiceStateMachine();
let recorder: RecorderHandle | undefined;
let activeSpeaker: Speaker | undefined;
/** The reply a conversation is waiting for, and the last time anyone said or heard anything (for the idle end). */
let awaitingId: string | undefined;
let lastActivity = 0;
let watchdog: ReturnType<typeof setTimeout> | undefined;
/** After a reply finishes, how long to wait for speech to begin before listening again (speech not wanted or empty). */
const REPLY_GRACE_MS = 1500;
const CONVERSATION_NO_SPEECH_MS = 15_000;

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
      // Google's speech service reads WAV, not the browser's WebM. If the conversion is not possible, the original
      // is sent and the service decides.
      let sending = { blob, mimeType };
      if (get().capabilities?.sttEngine === 'gemini' && runtime.toWav) {
        try {
          sending = { blob: await runtime.toWav(blob), mimeType: 'audio/wav' };
        } catch {
          /* keep the original recording */
        }
      }
      const audio = await blobToBase64(sending.blob);
      const result = await invoke('voice:transcribe', { audio, mimeType: sending.mimeType });
      // The user may have cancelled or started over while we waited: a stale result is dropped, never acted on.
      const done = machine.dispatch({ type: 'transcribed', epoch });
      if (!done.ok) return;
      sync();
      set({ levels: [] });
      const { action, reasons } = result.decision;
      if (action === 'discard') {
        // In a conversation, silence is not a problem to report: just keep listening.
        if (get().conversation) onSilence();
        else set({ notice: { kind: 'no_speech' } });
      } else if (action === 'review')
        set({ review: { text: result.text, confidence: result.confidence, reasons } });
      else await submit(result.text);
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'UNKNOWN';
      fail(epoch, { kind: 'error', code });
      // A failure ends a hands-free conversation: carrying on would only fail again, with the microphone open.
      if (get().conversation) endQuietly();
    }
  };

  const submit = async (text: string) => {
    useUiStore.getState().navigate('chat');
    lastActivity = Date.now();
    set({ notice: null });
    try {
      const message = await useChatStore.getState().send(text, undefined, 'voice');
      if (!get().conversation) return;
      if (message?.status === 'streaming') {
        awaitingId = message.id;
        set({ awaitingReply: true });
      } else if (message?.status === 'complete') {
        // A reply Allaya wrote itself: it is read aloud now, and the microphone comes back after that.
        armWatchdog();
      } else {
        resume();
      }
    } catch (error) {
      set({ notice: { kind: 'error', code: error instanceof IpcError ? error.code : 'UNKNOWN' } });
      if (get().conversation) endQuietly();
    }
  };

  // ── hands-free conversation ───────────────────────────────────────────────
  /** Closes everything and leaves the conversation, keeping any notice already set. */
  const endQuietly = () => {
    awaitingId = undefined;
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
    set({ conversation: false, awaitingReply: false });
  };

  /** Listens again, if a conversation is on and nothing else is going on (a reply, a question to the person). */
  const resume = () => {
    if (!get().conversation) return;
    if (machine.state !== 'IDLE' || get().review || awaitingId) return;
    void beginListening(true);
  };

  /** If speech has not begun shortly after a reply finished (voice replies off, nothing to read), carry on. */
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      watchdog = undefined;
      resume();
    }, REPLY_GRACE_MS);
  };

  /** A listening round with nobody speaking: go round again, unless it has been quiet too long. */
  const onSilence = () => {
    if (!get().conversation) return;
    const idleMs = settings()['voice.conversationIdleSeconds'] * 1000;
    if (Date.now() - lastActivity >= idleMs) {
      const result = machine.dispatch({ type: 'interrupt' });
      if (result.ok) run(result.effects);
      endQuietly();
      set({ state: machine.state, levels: [], notice: { kind: 'conversation_idle' } });
      return;
    }
    resume();
  };

  /** `keepNotice`: a conversation going round again must not wipe what it just told the person. */
  const beginListening = async (keepNotice = false) => {
    const started = machine.dispatch({ type: 'start_listening' });
    if (!started.ok) return;
    run(started.effects);
    const epoch = started.snapshot.epoch;
    set({
      state: machine.state,
      review: null,
      ...(keepNotice ? {} : { notice: null }),
      levels: [],
    });

    let handle: RecorderHandle;
    try {
      handle = await runtime.startRecording({
        deviceId: settings()['voice.inputDeviceId'],
        // In a conversation, waiting for the next thing to say is normal: be patient, and ask less often.
        ...(get().conversation ? { vad: { noSpeechTimeoutMs: CONVERSATION_NO_SPEECH_MS } } : {}),
        onLevel: (level) => {
          if (machine.snapshot.epoch !== epoch) return;
          set((s) => ({ levels: [...s.levels, level].slice(-LEVEL_BARS) }));
        },
      });
    } catch (error) {
      const reason = error instanceof RecorderError ? error.reason : 'failed';
      fail(epoch, { kind: 'error', code: `mic_${reason}` });
      if (get().conversation) endQuietly();
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
      const quiet = result.kind === 'no_speech';
      set({
        state: machine.state,
        levels: [],
        // In a conversation, a quiet moment is not worth a message.
        notice: quiet && !get().conversation ? { kind: 'no_speech' } : null,
      });
      if (quiet) onSilence();
    }
  };

  // The reply a conversation waits for finishes (or fails, or is cancelled): read it aloud, or go back to listening.
  useChatStore.subscribe((chat) => {
    if (!awaitingId) return;
    const id = awaitingId;
    for (const list of Object.values(chat.messages)) {
      const message = list.find((m) => m.id === id);
      if (!message || message.status === 'streaming') continue;
      awaitingId = undefined;
      set({ awaitingReply: false });
      lastActivity = Date.now();
      // A reply that finished well is read aloud by the voice bridge, and the microphone comes back after that;
      // the short wait is for the cases where nothing is read. A failed one has nothing to read.
      if (message.status === 'complete') armWatchdog();
      else resume();
      return;
    }
  });

  return {
    state: 'IDLE',
    levels: [],
    review: null,
    notice: null,
    capabilities: null,
    conversation: false,
    awaitingReply: false,
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
      // In a conversation the button means one thing: end it.
      if (get().conversation) return get().endConversation();
      if (state === 'LISTENING') return get().finishListening();
      if (state === 'SPEAKING' || state === 'PROCESSING') return get().interrupt();
      return get().start();
    },

    async start() {
      if (!settings()['voice.enabled']) {
        set({ setupOpen: true });
        return;
      }
      // With hands-free on, one click starts a conversation; the person ends it.
      if (settings()['voice.conversation'] && !get().conversation) {
        await get().startConversation();
        return;
      }
      await beginListening();
    },

    async startConversation() {
      if (!settings()['voice.enabled']) {
        set({ setupOpen: true });
        return;
      }
      if (get().conversation) return;
      lastActivity = Date.now();
      awaitingId = undefined;
      set({ conversation: true, awaitingReply: false });
      await beginListening();
    },

    endConversation(notice) {
      endQuietly();
      const result = machine.dispatch({ type: 'interrupt' });
      if (result.ok) run(result.effects);
      set({ state: machine.state, levels: [], review: null, ...(notice ? { notice } : {}) });
    },

    skip() {
      if (!get().conversation || machine.state !== 'SPEAKING') return;
      const result = machine.dispatch({ type: 'interrupt' });
      if (result.ok) run(result.effects);
      set({ state: machine.state, levels: [] });
      lastActivity = Date.now();
      resume();
    },

    finishListening() {
      recorder?.stop();
    },

    interrupt() {
      // The emergency stop and the STOP button: everything ends, a conversation included.
      endQuietly();
      const result = machine.dispatch({ type: 'interrupt' });
      if (result.ok) run(result.effects);
      set({ state: machine.state, levels: [] });
    },

    async speak(text, language) {
      const engine = settings()['voice.speechEngine'];
      const prepared = prepareSpeechText(text, {
        linkWord: language === 'bn' ? 'লিংক' : 'link',
        codeWord: language === 'bn' ? 'কোড' : 'code',
      });
      // Only the expressive voice understands "[whispers]"; every other voice would read it out.
      const spoken = engine === 'gemini' ? cleanAudioTags(prepared) : stripAudioTags(prepared);
      // Nothing to say unless there is at least one real word (tags and full stops alone are not speech).
      if (!/[\p{L}\p{N}]/u.test(stripAudioTags(spoken))) {
        resume();
        return;
      }
      const started = machine.dispatch({ type: 'start_speaking' });
      if (!started.ok) return; // busy listening/processing: never talk over the user
      const epoch = started.snapshot.epoch;
      set({ state: machine.state });
      const speaker = speakerFor(engine);
      activeSpeaker = speaker;
      try {
        await speaker.speak(spoken, language);
        const done = machine.dispatch({ type: 'finished_speaking', epoch });
        if (done.ok) {
          sync();
          // The reply is heard: in a conversation, it is the person's turn.
          lastActivity = Date.now();
          resume();
        }
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
        // Not being able to speak does not end a conversation: the reply is on the screen.
        resume();
      } finally {
        if (activeSpeaker === speaker && machine.state !== 'SPEAKING') activeSpeaker = undefined;
      }
    },

    confirmReview(text) {
      const trimmed = text.trim();
      set({ review: null });
      if (trimmed) void submit(trimmed);
    },
    dismissReview() {
      set({ review: null });
      resume();
    },
    dismissNotice: () => set({ notice: null }),
  };
});

/** For tests: releases any hardware and returns to a pristine idle machine with the default runtime. */
export function resetVoiceForTests(): void {
  useVoiceStore.getState().interrupt();
  machine.dispatch({ type: 'reset' });
  recorder = undefined;
  activeSpeaker = undefined;
  awaitingId = undefined;
  lastActivity = 0;
  if (watchdog) clearTimeout(watchdog);
  watchdog = undefined;
  configureVoiceRuntime(undefined);
  useVoiceStore.setState({
    state: 'IDLE',
    levels: [],
    review: null,
    notice: null,
    capabilities: null,
    conversation: false,
    awaitingReply: false,
    setupOpen: false,
  });
}

export const isVoiceActive = (state: VoiceState) =>
  state === 'LISTENING' || state === 'PROCESSING' || state === 'SPEAKING';
