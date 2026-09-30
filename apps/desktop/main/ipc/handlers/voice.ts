import type { HandlerRegistry } from '../registry';
import type { VoiceService } from '../../services/voice-service';

export function registerVoiceHandlers(registry: HandlerRegistry, voice: VoiceService): void {
  registry
    .register('voice:getCapabilities', () => voice.capabilities())
    .register('voice:transcribe', (input) => voice.transcribe(input))
    .register('voice:synthesize', (input) => voice.synthesize(input))
    .register('voice:listSpeechModels', () => voice.speechModels());
}
