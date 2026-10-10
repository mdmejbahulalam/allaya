import { chunkForSpeech, pickVoice, type VoiceInfo } from '@allaya/speech';
import { invoke } from '../api';

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

/** Speaks text in a language, and can be silenced at any moment. */
export interface Speaker {
  /** Resolves when the speech ends *or is stopped*; rejects with SpeechError when it cannot speak at all. */
  speak(text: string, language: 'bn' | 'en'): Promise<void>;
  stop(): void;
}

/** `speechSynthesis` reports its voices late; wait briefly for them. */
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

const toVoiceInfo = (v: SpeechSynthesisVoice): VoiceInfo => ({
  voiceURI: v.voiceURI,
  name: v.name,
  lang: v.lang,
  localService: v.localService,
  default: v.default,
});

/** The voices installed on this computer (Windows: the ones in its speech settings). Free, and nothing leaves the PC. */
export class SystemSpeaker implements Speaker {
  private token = 0;

  async speak(text: string, language: 'bn' | 'en'): Promise<void> {
    const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis;
    if (!synth) throw new SpeechError('unsupported');
    const voices = (await loadVoices(synth)).map(toVoiceInfo);
    const voice = pickVoice(voices, language);
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
        utterance.onend = () => resolve();
        utterance.onerror = (event) => {
          // "interrupted" and "canceled" are what stop() causes: a normal end, not a failure.
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

export interface ServiceSpeakerOptions {
  /** Try a service, voice or style without saving it (the settings preview). */
  connectionId?: string;
  voice?: string;
  style?: string;
  /** Longest piece sent at once. A short piece starts sooner; an expressive voice makes a whole piece first. */
  chunkChars?: number;
}

/** Speech made by a connected AI service, through the engine (the key never reaches the screen). */
export class ServiceSpeaker implements Speaker {
  private token = 0;
  private audio: HTMLAudioElement | undefined;

  constructor(private readonly options: ServiceSpeakerOptions = {}) {}

  async speak(text: string, language: 'bn' | 'en'): Promise<void> {
    const mine = ++this.token;
    const chunks = chunkForSpeech(text, this.options.chunkChars ?? 900);
    const { connectionId, voice, style } = this.options;
    const fetchChunk = async (chunk: string) => {
      const out = await invoke('voice:synthesize', {
        text: chunk,
        language,
        ...(connectionId ? { connectionId } : {}),
        ...(voice ? { voice } : {}),
        ...(style !== undefined ? { style } : {}),
      });
      const bytes = Uint8Array.from(atob(out.audio), (c) => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: out.mimeType }));
    };
    // Fetch the next piece while this one plays, so there is no gap between sentences.
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
      // A failed prefetch must not become an unhandled rejection while this piece is still playing.
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
