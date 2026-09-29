import { chunkForSpeech, pickVoice, type VoiceInfo } from '@allaya/speech';
import { invoke } from '@renderer/lib/api';

export type SpeechFailure = 'no_voice' | 'unsupported' | 'failed';

export class SpeechError extends Error {
  constructor(
    readonly reason: SpeechFailure,
    cause?: unknown,
  ) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = 'SpeechError';
  }
}

/** Speaks text in a language and can be silenced at any moment. */
export interface Speaker {
  /** Resolves when the speech ends *or is stopped*; rejects with SpeechError when it cannot speak at all. */
  speak(text: string, language: 'bn' | 'en'): Promise<void>;
  stop(): void;
}

export interface SystemSpeakerOptions {
  /** Read at speak time so settings changes apply immediately. */
  getRate(): number;
  getVoiceUri(): string;
}

/** `speechSynthesis` reports its voices asynchronously; wait briefly for them. */
function loadVoices(synth: SpeechSynthesis, timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    synth.addEventListener('voiceschanged', done);
  });
}

export const toVoiceInfo = (v: SpeechSynthesisVoice): VoiceInfo => ({
  voiceURI: v.voiceURI,
  name: v.name,
  lang: v.lang,
  localService: v.localService,
  default: v.default,
});

/** The installed Windows/OS voices via the Web Speech API. */
export class SystemSpeaker implements Speaker {
  private token = 0;

  constructor(private readonly options: SystemSpeakerOptions) {}

  async speak(text: string, language: 'bn' | 'en'): Promise<void> {
    const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis;
    if (!synth) throw new SpeechError('unsupported');
    const voices = (await loadVoices(synth)).map(toVoiceInfo);
    const voice = pickVoice(voices, language, this.options.getVoiceUri());
    // Never fall back to a voice for another language: an English voice reading Bengali is gibberish.
    if (!voice) throw new SpeechError('no_voice');
    const native = synth.getVoices().find((v) => v.voiceURI === voice.voiceURI);

    const mine = ++this.token;
    synth.cancel();
    for (const chunk of chunkForSpeech(text)) {
      if (mine !== this.token) return;
      await new Promise<void>((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(chunk);
        if (native) utterance.voice = native;
        utterance.lang = voice.lang;
        utterance.rate = this.options.getRate();
        utterance.onend = () => resolve();
        utterance.onerror = (event) => {
          // "interrupted"/"canceled" is what stop() causes; that is a normal end, not a failure.
          if (event.error === 'interrupted' || event.error === 'canceled') resolve();
          else reject(new SpeechError('failed', event.error));
        };
        synth.speak(utterance);
      });
    }
  }

  stop(): void {
    this.token += 1;
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  }
}

/** Speech synthesised by the configured cloud provider (through the main process; the key never reaches here). */
export class CloudSpeaker implements Speaker {
  private token = 0;
  private audio: HTMLAudioElement | undefined;

  async speak(text: string, language: 'bn' | 'en'): Promise<void> {
    const mine = ++this.token;
    const chunks = chunkForSpeech(text, 900);
    const fetchChunk = async (chunk: string) => {
      const out = await invoke('voice:synthesize', { text: chunk, language });
      const bytes = Uint8Array.from(atob(out.audio), (c) => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: out.mimeType }));
    };
    // Fetch the next chunk while the current one plays, so there is no gap between sentences.
    let next = chunks[0] ? fetchChunk(chunks[0]) : undefined;
    for (let i = 0; i < chunks.length; i += 1) {
      let url: string;
      try {
        url = await next!;
      } catch (error) {
        if (mine !== this.token) return;
        throw new SpeechError('failed', error);
      }
      next = chunks[i + 1] ? fetchChunk(chunks[i + 1]!) : undefined;
      // A rejected prefetch must not surface as an unhandled rejection while we are still playing.
      next?.catch(() => undefined);
      if (mine !== this.token) {
        URL.revokeObjectURL(url);
        return;
      }
      try {
        await this.play(url, mine);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (mine !== this.token) return;
    }
  }

  private play(url: string, token: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      this.audio = audio;
      audio.onended = () => resolve();
      audio.onpause = () => {
        if (token !== this.token) resolve();
      };
      audio.onerror = () => reject(new SpeechError('failed', audio.error));
      void audio
        .play()
        .catch((error: unknown) =>
          token !== this.token ? resolve() : reject(new SpeechError('failed', error)),
        );
    });
  }

  stop(): void {
    this.token += 1;
    this.audio?.pause();
    this.audio = undefined;
  }
}
