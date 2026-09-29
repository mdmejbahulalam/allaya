/**
 * Energy-based voice-activity detection with hysteresis and an adaptive noise floor.
 *
 * It deliberately knows nothing about audio APIs: the host feeds it one RMS level (0..1) per frame, which keeps it
 * deterministic and unit-testable. It answers three questions the recorder needs:
 *   - has the user started speaking?  (`speech_start`)
 *   - have they finished?             (`speech_end`, after `endSilenceMs` of quiet, or `max_length`)
 *   - is anyone there at all?         (`no_speech`, after `noSpeechTimeoutMs`)
 */
export interface VadOptions {
  /** Absolute floor for the speech threshold (RMS 0..1) so a dead-silent room does not trigger on hiss. */
  minThreshold: number;
  /** Speech must exceed `noiseFloor × noiseMargin`. */
  noiseMargin: number;
  /** While speaking, the level may dip to `threshold × stopRatio` before it counts as silence (hysteresis). */
  stopRatio: number;
  /** Continuous loud time before speech is declared — rejects clicks and keyboard thumps. */
  minSpeechMs: number;
  /** Quiet time that ends an utterance. Bengali speech has longer mid-sentence pauses; keep this generous. */
  endSilenceMs: number;
  maxUtteranceMs: number;
  /** Give up if nobody speaks for this long after listening started. */
  noSpeechTimeoutMs: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  minThreshold: 0.015,
  noiseMargin: 3,
  stopRatio: 0.6,
  minSpeechMs: 150,
  endSilenceMs: 1100,
  maxUtteranceMs: 30_000,
  noSpeechTimeoutMs: 8_000,
};

export type VadEvent =
  | { type: 'speech_start'; atMs: number }
  | { type: 'speech_end'; atMs: number; speechMs: number; reason: 'silence' | 'max_length' }
  | { type: 'no_speech'; atMs: number };

export class EnergyVad {
  private readonly options: VadOptions;
  private now = 0;
  private floor = 0.004;
  private speaking = false;
  private candidateMs = 0;
  private candidateStart = 0;
  private silenceMs = 0;
  private speechStart = 0;
  private finished = false;

  constructor(options: Partial<VadOptions> = {}) {
    this.options = { ...DEFAULT_VAD_OPTIONS, ...options };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Current speech threshold (RMS), exposed for tests and calibration UIs. */
  get threshold(): number {
    return Math.max(this.options.minThreshold, this.floor * this.options.noiseMargin);
  }

  reset(): void {
    this.now = 0;
    this.floor = 0.004;
    this.speaking = false;
    this.candidateMs = 0;
    this.silenceMs = 0;
    this.finished = false;
  }

  /** Feeds one frame. Returns at most one event; after `speech_end`/`no_speech` further frames are ignored. */
  push(rms: number, frameMs: number): VadEvent | undefined {
    if (this.finished) return undefined;
    const level = Number.isFinite(rms) ? Math.max(0, rms) : 0;
    const frameStart = this.now;
    this.now += frameMs;

    if (!this.speaking) {
      const loud = level > this.threshold;
      // The floor is learned from quiet frames only — speech must never raise its own threshold — and it
      // drops quickly but rises slowly. A steady hum above the threshold is therefore not "learned away":
      // raise `minThreshold` (a calibration setting) for such rooms.
      if (!loud) this.floor += (level - this.floor) * (level < this.floor ? 0.3 : 0.01);

      if (loud) {
        if (this.candidateMs === 0) this.candidateStart = frameStart;
        this.candidateMs += frameMs;
        if (this.candidateMs >= this.options.minSpeechMs) {
          this.speaking = true;
          this.speechStart = this.candidateStart;
          this.silenceMs = 0;
          return { type: 'speech_start', atMs: this.candidateStart };
        }
      } else {
        this.candidateMs = 0;
      }
      if (this.now >= this.options.noSpeechTimeoutMs) {
        this.finished = true;
        return { type: 'no_speech', atMs: this.now };
      }
      return undefined;
    }

    if (level > this.threshold * this.options.stopRatio) this.silenceMs = 0;
    else this.silenceMs += frameMs;

    const speechMs = this.now - this.speechStart;
    if (this.silenceMs >= this.options.endSilenceMs) {
      this.finished = true;
      return {
        type: 'speech_end',
        atMs: this.now,
        speechMs: speechMs - this.silenceMs,
        reason: 'silence',
      };
    }
    if (speechMs >= this.options.maxUtteranceMs) {
      this.finished = true;
      return { type: 'speech_end', atMs: this.now, speechMs, reason: 'max_length' };
    }
    return undefined;
  }
}

/** Root-mean-square of a block of samples in -1..1. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}
