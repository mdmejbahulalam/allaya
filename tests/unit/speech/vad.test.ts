import { describe, expect, it } from 'vitest';
import { EnergyVad, rms, type VadEvent } from '@allaya/speech';

const FRAME = 50;
/** Feeds `levels` (one per frame) and collects events. */
function feed(vad: EnergyVad, levels: number[]): VadEvent[] {
  return levels.map((l) => vad.push(l, FRAME)).filter((e): e is VadEvent => e !== undefined);
}
const repeat = (level: number, ms: number) => Array<number>(Math.round(ms / FRAME)).fill(level);

describe('rms', () => {
  it('measures signal energy', () => {
    expect(rms([])).toBe(0);
    expect(rms([0, 0, 0])).toBe(0);
    expect(rms([1, -1, 1, -1])).toBeCloseTo(1);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
  });
});

describe('energy VAD', () => {
  it('detects the start and the end of an utterance', () => {
    const vad = new EnergyVad();
    const events = feed(vad, [...repeat(0.004, 500), ...repeat(0.2, 1000), ...repeat(0.004, 1500)]);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
    const end = events[1] as Extract<VadEvent, { type: 'speech_end' }>;
    expect(end.reason).toBe('silence');
    expect(end.speechMs).toBeGreaterThanOrEqual(900);
    expect(end.speechMs).toBeLessThanOrEqual(1100);
  });

  it('ignores short bursts such as key clicks', () => {
    const vad = new EnergyVad();
    const events = feed(vad, [
      ...repeat(0.004, 300),
      ...repeat(0.5, 100),
      ...repeat(0.004, 300),
      ...repeat(0.5, 100),
      ...repeat(0.004, 300),
    ]);
    expect(events).toEqual([]);
    expect(vad.isSpeaking).toBe(false);
  });

  it('keeps one utterance together across a natural mid-sentence pause', () => {
    const vad = new EnergyVad();
    const events = feed(vad, [
      ...repeat(0.2, 600),
      ...repeat(0.004, 700),
      ...repeat(0.2, 600),
      ...repeat(0.004, 1500),
    ]);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
  });

  it('hysteresis: quiet-but-not-silent speech does not end the utterance', () => {
    const vad = new EnergyVad();
    const start = vad.threshold;
    const events = feed(vad, [...repeat(0.2, 500), ...repeat(start * 0.7, 3000)]); // above the stop level, below the start level
    expect(events.map((e) => e.type)).toEqual(['speech_start']);
    expect(vad.isSpeaking).toBe(true);
  });

  it('gives up when nobody speaks', () => {
    const vad = new EnergyVad({ noSpeechTimeoutMs: 2000 });
    const events = feed(vad, repeat(0.004, 3000));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'no_speech' });
  });

  it('cuts off runaway recordings at the maximum length', () => {
    const vad = new EnergyVad({ maxUtteranceMs: 2000 });
    const events = feed(vad, repeat(0.3, 5000));
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
    expect(events[1]).toMatchObject({ reason: 'max_length' });
  });

  it('learns the noise floor from quiet frames only, so speech never raises its own threshold', () => {
    const vad = new EnergyVad();
    const before = vad.threshold;
    feed(vad, [...repeat(0.004, 300), ...repeat(0.5, 400)]);
    expect(vad.threshold).toBe(before);
  });

  it('a room noisier than the threshold needs a higher calibrated minimum', () => {
    const hum = repeat(0.02, 3000);
    expect(
      feed(new EnergyVad({ noSpeechTimeoutMs: 60_000 }), hum).some(
        (e) => e.type === 'speech_start',
      ),
    ).toBe(true);
    const calibrated = new EnergyVad({ noSpeechTimeoutMs: 60_000, minThreshold: 0.05 });
    expect(feed(calibrated, hum)).toEqual([]);
    expect(feed(calibrated, repeat(0.3, 500)).map((e) => e.type)).toEqual(['speech_start']); // speech still gets through
  });

  it('is inert after it has finished, and can be reset for the next utterance', () => {
    const vad = new EnergyVad({ noSpeechTimeoutMs: 500 });
    feed(vad, repeat(0.004, 600));
    expect(feed(vad, repeat(0.5, 1000))).toEqual([]);
    vad.reset();
    expect(feed(vad, repeat(0.5, 500)).map((e) => e.type)).toEqual(['speech_start']);
  });

  it('survives garbage input', () => {
    const vad = new EnergyVad();
    expect(() => feed(vad, [Number.NaN, Number.POSITIVE_INFINITY, -1, 0])).not.toThrow();
  });
});
