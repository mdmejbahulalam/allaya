import { OpenAiCompatibleStt, OpenAiCompatibleTts } from '@allaya/voice';
import { decideSubmission } from '@allaya/speech';
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
  'Allaya, আল্লায়া, Chrome, ক্রোম, Downloads, Desktop, Documents, খুলে দাও, বন্ধ করো, খুঁজে দাও';

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

  capabilities(): VoiceCapabilities {
    const { providers, settings } = this.deps;
    const hasKey = providers.hasKey('openai');
    return {
      enabled: settings.get('voice.enabled'),
      sttAvailable: hasKey,
      cloudTtsAvailable: hasKey,
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
      const stt = new OpenAiCompatibleStt(
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
  }): Promise<{ audio: string; mimeType: 'audio/mpeg' }> {
    const { providers, settings, runs } = this.deps;
    this.requireEnabled();
    const runId = `voice:tts:${newId('run')}`;
    const source = runs.start(runId, 'voice');
    try {
      const tts = new OpenAiCompatibleTts(
        providers.audioEndpoint('openai'),
        settings.get('voice.ttsModel'),
        settings.get('voice.cloudVoice'),
      );
      const out = await tts.synthesize(input.text, {
        language: input.language,
        signal: source.signal,
      });
      return { audio: Buffer.from(out.bytes).toString('base64'), mimeType: 'audio/mpeg' };
    } finally {
      runs.finish(runId);
    }
  }

  private requireEnabled(): void {
    if (!this.deps.settings.get('voice.enabled')) {
      throw new AllayaError('Voice is turned off', { code: 'PERMISSION_REQUIRED' });
    }
  }
}
