import { prepareSpeechText } from '@allaya/speech';
import { create } from 'zustand';
import type { VoiceOptions } from '../../../shared/ipc';
import { invoke } from '../lib/api';
import { speechLanguage } from '../lib/text-lang';
import {
  RecorderError,
  blobToBase64,
  startRecording,
  type RecorderHandle,
  type RecordingFailure,
} from '../lib/voice/recorder';
import { ServiceSpeaker, SpeechError, SystemSpeaker, type Speaker } from '../lib/voice/speaker';
import { recordingToWav } from '../lib/voice/wav';
import { useAppStore } from './app';
import { useChatStore } from './chat';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

/** Why the conversation is not going, for the screen to explain in words. */
export type VoiceNotice =
  | { kind: 'no_stt' }
  | { kind: 'mic'; reason: RecordingFailure }
  | { kind: 'no_voice' }
  | { kind: 'speech_failed' }
  | { kind: 'error'; code: string }
  | { kind: 'idle' };

/** What the conversation needs from the outside, so a test can stand in for the microphone and the speakers. */
export interface VoiceRuntime {
  startRecording: typeof startRecording;
  toWav: (blob: Blob) => Promise<Blob>;
  toBase64: (blob: Blob) => Promise<string>;
  makeSpeaker: (options: VoiceOptions, ttsStyle: string) => Speaker;
  now: () => number;
}

const defaultRuntime: VoiceRuntime = {
  startRecording,
  toWav: recordingToWav,
  toBase64: blobToBase64,
  makeSpeaker: (options, ttsStyle) =>
    options.tts
      ? new ServiceSpeaker({
          connectionId: options.tts.connectionId,
          voice: options.tts.voice,
          style: ttsStyle,
          // A voice that directs its delivery makes a whole piece first: keep the pieces short so it starts soon.
          chunkChars: options.tts.expressive ? 400 : 900,
        })
      : new SystemSpeaker(),
  now: () => Date.now(),
};

let runtime: VoiceRuntime = defaultRuntime;
export const setVoiceRuntime = (next: Partial<VoiceRuntime> | null) => {
  runtime = { ...defaultRuntime, ...(next ?? {}) };
};

/** Silence ends the conversation after this long: the microphone must not stay open for hours. */
export const CONVERSATION_IDLE_MS = 120_000;
/** How long one round of listening waits for a first word before it starts over. */
const NO_SPEECH_MS = 15_000;

const WORDS = {
  en: { linkWord: 'link', codeWord: 'code block' },
  bn: { linkWord: 'লিংক', codeWord: 'কোড' },
};

interface VoiceStore {
  /** A conversation is going: listening, answering, speaking, and listening again. */
  active: boolean;
  state: VoiceState;
  /** 0..1, for the level meter. */
  level: number;
  notice: VoiceNotice | null;
  /** The text being read aloud outside a conversation (a "read aloud" button, or replies read aloud). */
  speakingAloud: boolean;
  toggle: () => Promise<void>;
  start: () => Promise<void>;
  end: (notice?: VoiceNotice) => void;
  /** Stop reading the current reply and listen. */
  skip: () => void;
  speakText: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  clearNotice: () => void;
}

let epoch = 0;
let handle: RecorderHandle | undefined;
let speaker: Speaker | undefined;
let lastActivity = 0;
let options: VoiceOptions | undefined;

const speechSettings = () => useAppStore.getState().settings.voice;

/** Everything waiting on the conversation, told to stop waiting when it ends. */
const waiters = new Set<() => void>();

/** Resolves with how the reply ended: when it is no longer being written, or `gone` if the conversation ended. */
function waitForReply(
  replyId: string,
  myEpoch: number,
): Promise<'complete' | 'error' | 'cancelled' | 'gone'> {
  return new Promise((resolve) => {
    const look = (messages: ReturnType<typeof useChatStore.getState>['messages']) => {
      if (myEpoch !== epoch) return 'gone' as const;
      const message = messages.find((m) => m.id === replyId);
      if (!message) return 'gone' as const;
      return message.status === 'streaming' ? undefined : message.status;
    };
    const now = look(useChatStore.getState().messages);
    if (now) {
      resolve(now);
      return;
    }
    const done = (outcome: 'complete' | 'error' | 'cancelled' | 'gone') => {
      off();
      waiters.delete(ended);
      resolve(outcome);
    };
    const ended = () => done('gone');
    const off = useChatStore.subscribe((state) => {
      const outcome = look(state.messages);
      if (outcome) done(outcome);
    });
    waiters.add(ended);
  });
}

export const useVoiceStore = create<VoiceStore>((set, get) => {
  const finish = (notice?: VoiceNotice) => {
    epoch += 1;
    for (const ended of [...waiters]) ended();
    handle?.cancel();
    handle = undefined;
    speaker?.stop();
    speaker = undefined;
    set({ active: false, state: 'idle', level: 0, notice: notice ?? null });
  };

  const explain = (error: unknown): VoiceNotice => {
    const code = (error as { code?: string } | null)?.code ?? 'UNKNOWN';
    const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
    return reason === 'no_stt' ? { kind: 'no_stt' } : { kind: 'error', code };
  };

  async function speakReply(text: string, myEpoch: number): Promise<void> {
    if (!options) return;
    const language = speechLanguage(text);
    const spoken = prepareSpeechText(text, WORDS[language]);
    if (!spoken) return;
    set({ state: 'speaking' });
    speaker = runtime.makeSpeaker(options, speechSettings().ttsStyle);
    try {
      await speaker.speak(spoken, language);
    } catch (error) {
      if (myEpoch !== epoch) return;
      // A voice that cannot speak does not end the conversation: the reply is on the screen.
      set({
        notice:
          error instanceof SpeechError && error.reason === 'no_voice'
            ? { kind: 'no_voice' }
            : { kind: 'speech_failed' },
      });
    } finally {
      speaker = undefined;
    }
  }

  async function conversation(myEpoch: number): Promise<void> {
    while (myEpoch === epoch) {
      set({ state: 'listening', level: 0 });
      try {
        handle = await runtime.startRecording({
          autoStop: true,
          vad: { noSpeechTimeoutMs: NO_SPEECH_MS },
          onLevel: (level) => myEpoch === epoch && set({ level }),
        });
      } catch (error) {
        if (myEpoch === epoch)
          finish({ kind: 'mic', reason: error instanceof RecorderError ? error.reason : 'failed' });
        return;
      }
      if (myEpoch !== epoch) {
        // Ended while the microphone was starting.
        handle.cancel();
        handle = undefined;
        return;
      }
      const result = await handle.finished;
      handle = undefined;
      if (myEpoch !== epoch || result.kind === 'cancelled') return;
      if (result.kind === 'no_speech') {
        if (runtime.now() - lastActivity > CONVERSATION_IDLE_MS) return finish({ kind: 'idle' });
        continue;
      }

      set({ state: 'transcribing', level: 0 });
      let text: string;
      try {
        const blob = options?.stt?.needsWav ? await runtime.toWav(result.blob) : result.blob;
        const heard = await invoke('voice:transcribe', {
          audio: await runtime.toBase64(blob),
          mimeType: blob.type || result.mimeType,
        });
        text = heard.noSpeech ? '' : heard.text.trim();
      } catch (error) {
        if (myEpoch === epoch) finish(explain(error));
        return;
      }
      if (myEpoch !== epoch) return;
      if (!text) {
        if (runtime.now() - lastActivity > CONVERSATION_IDLE_MS) return finish({ kind: 'idle' });
        continue;
      }

      lastActivity = runtime.now();
      set({ state: 'thinking' });
      try {
        await useChatStore.getState().send(text);
      } catch (error) {
        if (myEpoch === epoch) finish(explain(error));
        return;
      }
      const reply = useChatStore.getState().messages.at(-1);
      if (!reply) return finish();
      const outcome = await waitForReply(reply.id, myEpoch);
      if (myEpoch !== epoch) return;
      if (outcome !== 'complete') {
        // The reply failed or was stopped: the chat says why, and the conversation ends there.
        return finish();
      }
      const finished = useChatStore.getState().messages.find((m) => m.id === reply.id);
      if (finished?.content) await speakReply(finished.content, myEpoch);
      lastActivity = runtime.now();
    }
  }

  return {
    active: false,
    state: 'idle',
    level: 0,
    notice: null,
    speakingAloud: false,

    async start() {
      if (get().active) return;
      finish();
      const myEpoch = epoch;
      set({ active: true, state: 'listening', notice: null });
      try {
        options = await invoke('voice:options');
      } catch (error) {
        return finish(explain(error));
      }
      if (myEpoch !== epoch) return;
      if (!options.stt) return finish({ kind: 'no_stt' });
      lastActivity = runtime.now();
      await conversation(myEpoch);
    },

    async toggle() {
      if (get().active) get().end();
      else await get().start();
    },

    end(notice) {
      finish(notice);
    },

    skip() {
      // Stopping the voice ends this piece of speech; the loop then goes back to listening.
      speaker?.stop();
    },

    async speakText(text) {
      if (get().active) return;
      get().stopSpeaking();
      try {
        options ??= await invoke('voice:options');
      } catch {
        return;
      }
      const language = speechLanguage(text);
      const spoken = prepareSpeechText(text, WORDS[language]);
      if (!spoken) return;
      const mine = ++epoch;
      speaker = runtime.makeSpeaker(options, speechSettings().ttsStyle);
      set({ speakingAloud: true });
      try {
        await speaker.speak(spoken, language);
      } catch (error) {
        if (mine === epoch)
          set({
            notice:
              error instanceof SpeechError && error.reason === 'no_voice'
                ? { kind: 'no_voice' }
                : { kind: 'speech_failed' },
          });
      } finally {
        if (mine === epoch) {
          speaker = undefined;
          set({ speakingAloud: false });
        }
      }
    },

    stopSpeaking() {
      if (get().active) return;
      epoch += 1;
      speaker?.stop();
      speaker = undefined;
      set({ speakingAloud: false });
    },

    clearNotice() {
      set({ notice: null });
    },
  };
});

/** For tests: how many things are still waiting on a reply. */
export const pendingWaits = (): number => waiters.size;

/** For tests: forget everything, as if the app had just started. */
export function resetVoiceForTests(): void {
  epoch += 1;
  handle = undefined;
  speaker = undefined;
  options = undefined;
  lastActivity = 0;
  setVoiceRuntime(null);
  useVoiceStore.setState({
    active: false,
    state: 'idle',
    level: 0,
    notice: null,
    speakingAloud: false,
  });
}
