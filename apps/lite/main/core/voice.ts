import {
  GeminiStt,
  GeminiTts,
  OpenAiCompatibleStt,
  OpenAiCompatibleTts,
  type SttProvider,
  type TtsProvider,
} from '@allaya/voice';
import {
  DEFAULT_EXPRESSIVE_MODEL,
  DEFAULT_EXPRESSIVE_VOICE,
  EXPRESSIVE_VOICES,
  stripAudioTags,
} from '@allaya/speech';
import { AllayaError } from '@allaya/shared';
import type { ConnectionView, SpeechEngine, VoiceOptions } from '../../shared/ipc';
import { MAX_AUDIO_BASE64_CHARS } from '../../shared/ipc';
import type { ConnectionService } from './connections';
import type { SettingsStore } from './settings';

const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
];

/** Words that help a speech model with the names it will hear most. */
const STT_PROMPT = 'Allaya, আলেয়া';

interface Capability {
  stt?: { model: string; style: 'openai' | 'gemini'; needsWav: boolean };
  tts?: {
    model: string;
    style: 'openai' | 'gemini';
    voices: Array<{ id: string; label: string }>;
    defaultVoice: string;
  };
}

/**
 * What each kind of connection can do with audio. A key for OpenAI or Google brings speech both ways; Groq listens;
 * the other services are for text. (Their voices can be added the same way, one entry here.)
 */
function capability(connection: ConnectionView): Capability {
  if (connection.kind === 'openai') {
    return {
      stt: { model: 'whisper-1', style: 'openai', needsWav: false },
      tts: {
        model: 'gpt-4o-mini-tts',
        style: 'openai',
        voices: OPENAI_VOICES.map((v) => ({ id: v, label: v })),
        defaultVoice: 'alloy',
      },
    };
  }
  if (connection.kind === 'google') {
    return {
      // Gemini reads a plain audio file, not the microphone's WebM.
      stt: { model: 'gemini-2.5-flash', style: 'gemini', needsWav: true },
      tts: {
        model: DEFAULT_EXPRESSIVE_MODEL,
        style: 'gemini',
        voices: EXPRESSIVE_VOICES.map((v) => ({ id: v.name, label: `${v.name} — ${v.tone}` })),
        defaultVoice: DEFAULT_EXPRESSIVE_VOICE,
      },
    };
  }
  if (connection.presetId === 'groq') {
    return { stt: { model: 'whisper-large-v3-turbo', style: 'openai', needsWav: false } };
  }
  return {};
}

export interface VoiceDeps {
  settings: SettingsStore;
  connections: ConnectionService;
  /** Aborts every speech call (the emergency stop of the voice). */
  signal?: () => AbortSignal | undefined;
}

/**
 * Speech in and out, through the AI services the person has connected. Nothing here records or plays: the screen does
 * that, and hands audio over as base64. The key is read at the moment of each call and never kept.
 */
export class VoiceService {
  constructor(private readonly deps: VoiceDeps) {}

  private engines(): SpeechEngine[] {
    return this.deps.connections.list().flatMap((c) => {
      const cap = capability(c);
      if (!cap.stt && !cap.tts) return [];
      return [
        {
          connectionId: c.id,
          name: c.name,
          stt: cap.stt !== undefined,
          tts: cap.tts !== undefined,
          voices: cap.tts?.voices ?? [],
          needsWav: cap.stt?.needsWav ?? false,
          expressive: cap.tts?.style === 'gemini',
        },
      ];
    });
  }

  options(): VoiceOptions {
    const engines = this.engines();
    const { voice } = this.deps.settings.get();
    const listener =
      engines.find((e) => e.connectionId === voice.sttConnectionId && e.stt) ??
      engines.find((e) => e.stt);
    const speaker =
      voice.ttsEngine === 'service'
        ? (engines.find((e) => e.connectionId === voice.ttsConnectionId && e.tts) ??
          engines.find((e) => e.tts))
        : undefined;
    return {
      engines,
      stt: listener ? { connectionId: listener.connectionId, needsWav: listener.needsWav } : null,
      tts: speaker
        ? {
            connectionId: speaker.connectionId,
            voice: voice.ttsVoice || (speaker.voices[0]?.id ?? ''),
            expressive: speaker.expressive,
          }
        : null,
    };
  }

  private connection(id: string): ConnectionView {
    const found = this.deps.connections.list().find((c) => c.id === id);
    if (!found) throw new AllayaError('That connection does not exist', { code: 'NOT_FOUND' });
    return found;
  }

  async transcribe(input: { audio: string; mimeType: string }): Promise<{
    text: string;
    language: 'en' | 'bn' | null;
    noSpeech: boolean;
  }> {
    if (input.audio.length > MAX_AUDIO_BASE64_CHARS) {
      throw new AllayaError('That recording is too long', { code: 'INVALID_INPUT' });
    }
    const bytes = new Uint8Array(Buffer.from(input.audio, 'base64'));
    if (bytes.byteLength === 0)
      throw new AllayaError('No audio was recorded', { code: 'INVALID_INPUT' });
    const chosen = this.options().stt;
    if (!chosen) {
      throw new AllayaError('No speech-to-text service is set up', {
        code: 'PROVIDER_NOT_CONFIGURED',
        details: { reason: 'no_stt' },
      });
    }
    const connection = this.connection(chosen.connectionId);
    const stt = capability(connection).stt!;
    const endpoint = this.deps.connections.audioEndpoint(connection.id);
    const provider: SttProvider =
      stt.style === 'gemini'
        ? new GeminiStt(endpoint, stt.model)
        : new OpenAiCompatibleStt(endpoint, stt.model);
    const signal = this.deps.signal?.();
    const result = await provider.transcribe(
      { bytes, mimeType: input.mimeType },
      {
        language: this.deps.settings.get().voice.inputLanguage,
        prompt: STT_PROMPT,
        ...(signal ? { signal } : {}),
      },
    );
    return {
      text: result.noSpeech ? '' : result.text.trim(),
      language: result.language,
      noSpeech: result.noSpeech,
    };
  }

  async synthesize(input: {
    text: string;
    language: 'en' | 'bn';
    connectionId?: string | undefined;
    voice?: string | undefined;
    style?: string | undefined;
  }): Promise<{ audio: string; mimeType: 'audio/mpeg' | 'audio/wav' }> {
    const { voice: saved } = this.deps.settings.get();
    const connectionId = input.connectionId ?? this.options().tts?.connectionId;
    if (!connectionId) {
      throw new AllayaError('No speaking service is set up', {
        code: 'PROVIDER_NOT_CONFIGURED',
        details: { reason: 'no_tts' },
      });
    }
    const connection = this.connection(connectionId);
    const tts = capability(connection).tts;
    if (!tts) {
      throw new AllayaError('That service has no voice', {
        code: 'INVALID_INPUT',
        details: { reason: 'no_tts' },
      });
    }
    const endpoint = this.deps.connections.audioEndpoint(connection.id);
    const voice = input.voice ?? (saved.ttsVoice || tts.defaultVoice);
    const style = input.style ?? saved.ttsStyle;
    const signal = this.deps.signal?.();
    const common = { language: input.language, voice, ...(signal ? { signal } : {}) };
    let provider: TtsProvider;
    let text = input.text;
    if (tts.style === 'gemini') {
      provider = new GeminiTts(endpoint, { model: tts.model, voice, style });
    } else {
      provider = new OpenAiCompatibleTts(endpoint, tts.model, voice);
      // This voice does not understand tone tags: it would read "[whispers]" aloud.
      text = stripAudioTags(text);
    }
    const out = await provider.synthesize(text, common);
    return {
      audio: Buffer.from(out.bytes).toString('base64'),
      mimeType: out.mimeType === 'audio/mpeg' ? 'audio/mpeg' : 'audio/wav',
    };
  }
}
