import {
  GeminiStt,
  GeminiTts,
  OpenAiCompatibleStt,
  OpenAiCompatibleTts,
  listSpeechModels,
  type SttProvider,
} from '@allaya/voice';
import { DEFAULT_EXPRESSIVE_MODEL, decideSubmission, stripAudioTags } from '@allaya/speech';
import { AllayaError, newId, type Logger, type RunRegistry } from '@allaya/shared';
import {
  MAX_AUDIO_BASE64_CHARS,
  type TranscriptionResult,
  type VoiceCapabilities,
} from '@allaya/validation';
import type { ProviderService } from './provider-service';
import type { SettingsService } from './settings-service';

/** Vocabulary hint: product and app names that speech models otherwise mangle, in Bengali and English. */
const STT_PROMPT =
  'Allaya, আলেয়া, Chrome, ক্রোম, Downloads, Desktop, Documents, খুলে দাও, বন্ধ করো, খুঁজে দাও';

export interface VoiceServiceDeps {
  providers: ProviderService;
  settings: SettingsService;
  runs: RunRegistry;
  logger: Logger;
  now?: () => Date;
}

/**
 * Speech-to-text and text-to-speech for the renderer. Trust rules:
 *  - nothing is transcribed until the user has turned voice on (`voice.enabled`);
 *  - audio exists only in memory, only for the duration of the request — it is never written to disk or logged;
 *  - transcripts are not logged either (they may contain anything the user said);
 *  - the low-confidence gate runs here, in the trusted process, and the verdict travels with the transcript.
 */
export class VoiceService {
  constructor(private readonly deps: VoiceServiceDeps) {}

  /** Which service transcribes: the person's choice, or (automatic) OpenAI first, then Google. */
  sttEngine(): 'openai' | 'gemini' | null {
    const { providers, settings } = this.deps;
    const choice = settings.get('voice.sttEngine');
    if (choice !== 'gemini' && providers.hasKey('openai')) return 'openai';
    if (choice !== 'openai' && providers.hasKey('google')) return 'gemini';
    return null;
  }

  capabilities(): VoiceCapabilities {
    const { providers, settings } = this.deps;
    const hasKey = providers.hasKey('openai');
    const sttEngine = this.sttEngine();
    return {
      enabled: settings.get('voice.enabled'),
      sttAvailable: sttEngine !== null,
      sttEngine,
      cloudTtsAvailable: hasKey,
      expressiveTtsAvailable: providers.hasKey('google'),
    };
  }

  async transcribe(input: { audio: string; mimeType: string }): Promise<TranscriptionResult> {
    const { providers, settings, runs, logger } = this.deps;
    this.requireEnabled();
    if (input.audio.length > MAX_AUDIO_BASE64_CHARS) {
      throw new AllayaError('That recording is too long', { code: 'INVALID_INPUT' });
    }
    const bytes = new Uint8Array(Buffer.from(input.audio, 'base64'));
    if (bytes.byteLength === 0)
      throw new AllayaError('No audio was recorded', { code: 'INVALID_INPUT' });

    const runId = `voice:stt:${newId('run')}`;
    const source = runs.start(runId, 'voice');
    try {
      const engine = this.sttEngine();
      if (!engine) {
        throw new AllayaError('No speech-to-text service is set up', {
          code: 'PROVIDER_NOT_CONFIGURED',
        });
      }
      const stt: SttProvider =
        engine === 'gemini'
          ? new GeminiStt(providers.audioEndpoint('google'), settings.get('voice.geminiSttModel'))
          : new OpenAiCompatibleStt(
              providers.audioEndpoint('openai'),
              settings.get('voice.sttModel'),
            );
      const started = Date.now();
      const result = await stt.transcribe(
        { bytes, mimeType: input.mimeType },
        {
          language: settings.get('voice.inputLanguage'),
          prompt: STT_PROMPT,
          signal: source.signal,
        },
      );
      logger.debug('Transcribed audio', {
        bytes: bytes.byteLength,
        ms: Date.now() - started,
        noSpeech: result.noSpeech,
      });

      const decision = result.noSpeech
        ? ({ action: 'discard', reason: 'empty', text: '' } as const)
        : decideSubmission({
            transcript: result.text,
            confidence: result.confidence,
            policy: settings.get('voice.autoSend'),
            threshold: settings.get('voice.confidenceThreshold'),
            ...(this.deps.now ? { now: this.deps.now() } : {}),
          });
      return {
        text: decision.action === 'discard' ? '' : decision.text,
        language: result.language,
        confidence: result.confidence,
        noSpeech: result.noSpeech,
        decision: {
          action: decision.action,
          reasons: decision.action === 'review' ? decision.reasons : [],
        },
      };
    } finally {
      runs.finish(runId);
    }
  }

  async synthesize(input: {
    text: string;
    language: 'bn' | 'en';
    engine?: 'cloud' | 'gemini' | undefined;
    voice?: string | undefined;
    style?: string | undefined;
  }): Promise<{ audio: string; mimeType: 'audio/mpeg' | 'audio/wav' }> {
    const { providers, settings, runs } = this.deps;
    this.requireEnabled();
    const saved = settings.get('voice.speechEngine');
    const engine = input.engine ?? (saved === 'gemini' ? 'gemini' : 'cloud');
    const runId = `voice:tts:${newId('run')}`;
    const source = runs.start(runId, 'voice');
    try {
      if (engine === 'gemini') {
        const tts = new GeminiTts(providers.audioEndpoint('google'), {
          model: settings.get('voice.geminiModel'),
          voice: settings.get('voice.geminiVoice'),
          style: settings.get('voice.style'),
        });
        const out = await tts.synthesize(input.text, {
          language: input.language,
          ...(input.voice ? { voice: input.voice } : {}),
          ...(input.style !== undefined ? { style: input.style } : {}),
          signal: source.signal,
        });
        return {
          audio: Buffer.from(out.bytes).toString('base64'),
          mimeType: out.mimeType === 'audio/mpeg' ? 'audio/mpeg' : 'audio/wav',
        };
      }
      const tts = new OpenAiCompatibleTts(
        providers.audioEndpoint('openai'),
        settings.get('voice.ttsModel'),
        input.voice ?? settings.get('voice.cloudVoice'),
      );
      // This voice does not understand tone tags: it would read "[whispers]" aloud.
      const out = await tts.synthesize(stripAudioTags(input.text), {
        language: input.language,
        signal: source.signal,
      });
      return { audio: Buffer.from(out.bytes).toString('base64'), mimeType: 'audio/mpeg' };
    } finally {
      runs.finish(runId);
    }
  }

  /** Speech models the stored Google key can use, so the person picks from real ones. */
  async speechModels(): Promise<{ models: string[]; fetched: boolean }> {
    const { providers, logger } = this.deps;
    if (!providers.hasKey('google')) return { models: [DEFAULT_EXPRESSIVE_MODEL], fetched: false };
    try {
      const models = await listSpeechModels(providers.audioEndpoint('google'));
      return models.length > 0
        ? { models, fetched: true }
        : { models: [DEFAULT_EXPRESSIVE_MODEL], fetched: false };
    } catch (error) {
      logger.debug('Could not list speech models', { error: String(error).slice(0, 120) });
      return { models: [DEFAULT_EXPRESSIVE_MODEL], fetched: false };
    }
  }

  private requireEnabled(): void {
    if (!this.deps.settings.get('voice.enabled')) {
      throw new AllayaError('Voice is turned off', { code: 'PERMISSION_REQUIRED' });
    }
  }
}
