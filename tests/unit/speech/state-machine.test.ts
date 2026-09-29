import { describe, expect, it } from 'vitest';
import { VoiceStateMachine, type VoiceAction } from '@allaya/speech';

const run = (machine: VoiceStateMachine, ...actions: VoiceAction[]) =>
  actions.map((a) => machine.dispatch(a));

describe('voice state machine', () => {
  it('follows the happy path IDLE → LISTENING → PROCESSING → IDLE with the right effects', () => {
    const m = new VoiceStateMachine();
    const [listen, stop] = run(m, { type: 'start_listening' }, { type: 'stop_listening' });
    expect(listen).toMatchObject({
      ok: true,
      effects: ['open_microphone'],
      snapshot: { state: 'LISTENING', epoch: 1 },
    });
    expect(stop).toMatchObject({
      ok: true,
      effects: ['close_microphone', 'begin_transcription'],
      snapshot: { state: 'PROCESSING', epoch: 1 },
    });
    expect(m.dispatch({ type: 'transcribed', epoch: 1 })).toMatchObject({
      ok: true,
      snapshot: { state: 'IDLE' },
    });
  });

  it('never talks over the user, and never starts speech while a transcript is pending', () => {
    const m = new VoiceStateMachine();
    m.dispatch({ type: 'start_listening' });
    expect(m.dispatch({ type: 'start_speaking' })).toMatchObject({ ok: false, reason: 'invalid' });
    m.dispatch({ type: 'stop_listening' });
    expect(m.dispatch({ type: 'start_speaking' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(m.state).toBe('PROCESSING');
  });

  it("barge-in: the user speaking stops Allaya's speech and opens the microphone", () => {
    const m = new VoiceStateMachine();
    m.dispatch({ type: 'start_speaking' });
    const result = m.dispatch({ type: 'start_listening' });
    expect(result).toMatchObject({
      ok: true,
      effects: ['stop_speech', 'open_microphone'],
      snapshot: { state: 'LISTENING' },
    });
  });

  it('a completion from a cancelled session is ignored (a late transcription cannot resurrect old state)', () => {
    const m = new VoiceStateMachine();
    m.dispatch({ type: 'start_listening' });
    m.dispatch({ type: 'stop_listening' });
    const stale = m.snapshot.epoch;
    expect(m.dispatch({ type: 'interrupt' })).toMatchObject({
      ok: true,
      effects: ['abort_transcription'],
      snapshot: { state: 'IDLE' },
    });
    expect(m.dispatch({ type: 'transcribed', epoch: stale })).toMatchObject({
      ok: false,
      reason: 'stale',
    });
    expect(m.state).toBe('IDLE');

    // …and it stays ignored even after a *new* session has begun.
    m.dispatch({ type: 'start_listening' });
    m.dispatch({ type: 'stop_listening' });
    expect(m.dispatch({ type: 'transcribed', epoch: stale })).toMatchObject({
      ok: false,
      reason: 'stale',
    });
    expect(m.state).toBe('PROCESSING');
  });

  it('starting to listen while processing abandons the pending transcription', () => {
    const m = new VoiceStateMachine();
    m.dispatch({ type: 'start_listening' });
    m.dispatch({ type: 'stop_listening' });
    const old = m.snapshot.epoch;
    expect(m.dispatch({ type: 'start_listening' })).toMatchObject({
      ok: true,
      effects: ['abort_transcription', 'open_microphone'],
    });
    expect(m.dispatch({ type: 'transcribed', epoch: old })).toMatchObject({
      ok: false,
      reason: 'stale',
    });
  });

  it('interrupt always lands in IDLE and releases whatever is held', () => {
    const cases: Array<[VoiceAction[], string[]]> = [
      [[{ type: 'start_listening' }], ['close_microphone']],
      [[{ type: 'start_listening' }, { type: 'stop_listening' }], ['abort_transcription']],
      [[{ type: 'start_speaking' }], ['stop_speech']],
      [[], []],
    ];
    for (const [setup, effects] of cases) {
      const m = new VoiceStateMachine();
      run(m, ...setup);
      expect(m.dispatch({ type: 'interrupt' })).toMatchObject({
        ok: true,
        effects,
        snapshot: { state: 'IDLE' },
      });
    }
  });

  it('failure moves to ERROR with the message, releases resources, and recovers on the next start', () => {
    const m = new VoiceStateMachine();
    m.dispatch({ type: 'start_listening' });
    m.dispatch({ type: 'stop_listening' });
    const epoch = m.snapshot.epoch;
    expect(m.dispatch({ type: 'fail', epoch, message: 'offline' })).toMatchObject({
      ok: true,
      effects: ['abort_transcription'],
      snapshot: { state: 'ERROR', error: 'offline' },
    });
    expect(m.dispatch({ type: 'start_listening' })).toMatchObject({
      ok: true,
      snapshot: { state: 'LISTENING' },
    });
    expect(m.snapshot.error).toBeUndefined();
  });

  it('rejects impossible transitions without changing state', () => {
    const m = new VoiceStateMachine();
    expect(m.dispatch({ type: 'stop_listening' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(m.dispatch({ type: 'transcribed', epoch: 0 })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    m.dispatch({ type: 'start_listening' });
    expect(m.dispatch({ type: 'start_listening' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(m.state).toBe('LISTENING');
  });

  it('notifies subscribers of accepted transitions only', () => {
    const m = new VoiceStateMachine();
    const seen: string[] = [];
    const off = m.subscribe((s) => seen.push(s.state));
    m.dispatch({ type: 'stop_listening' }); // refused
    m.dispatch({ type: 'start_listening' });
    m.dispatch({ type: 'interrupt' });
    off();
    m.dispatch({ type: 'start_speaking' });
    expect(seen).toEqual(['LISTENING', 'IDLE']);
  });

  it('finishing speech returns to IDLE only for the current speech session', () => {
    const m = new VoiceStateMachine();
    m.dispatch({ type: 'start_speaking' });
    const first = m.snapshot.epoch;
    m.dispatch({ type: 'interrupt' });
    m.dispatch({ type: 'start_speaking' });
    expect(m.dispatch({ type: 'finished_speaking', epoch: first })).toMatchObject({
      ok: false,
      reason: 'stale',
    });
    expect(m.state).toBe('SPEAKING');
    expect(m.dispatch({ type: 'finished_speaking', epoch: m.snapshot.epoch })).toMatchObject({
      ok: true,
      snapshot: { state: 'IDLE' },
    });
  });
});
