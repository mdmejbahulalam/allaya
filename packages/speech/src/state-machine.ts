import type { VoiceState } from '@allaya/types';

/**
 * The voice pipeline as an explicit state machine.
 *
 *   IDLE ──start_listening──▶ LISTENING ──stop_listening──▶ PROCESSING ──transcribed──▶ IDLE
 *     │                          │                              │
 *     └──start_speaking──▶ SPEAKING ◀── (never while LISTENING) ┘        any state ──interrupt──▶ IDLE
 *
 * Two properties matter more than the diagram:
 *  1. Allaya never talks over the user: `start_speaking` is refused while listening.
 *  2. Asynchronous completions can arrive late (a transcription that finishes after the user cancelled). Every
 *     session has an `epoch`; completions carry the epoch they started under and are ignored when it is stale,
 *     so a cancelled request can never resurrect old state or submit an old transcript.
 */
export type VoiceAction =
  | { type: 'start_listening' }
  | { type: 'stop_listening' }
  | { type: 'transcribed'; epoch: number }
  | { type: 'start_speaking' }
  | { type: 'finished_speaking'; epoch: number }
  | { type: 'fail'; epoch: number; message: string }
  /** Barge-in / cancel / emergency stop. Always succeeds and always lands in IDLE. */
  | { type: 'interrupt' }
  | { type: 'reset' };

/** Side effects the host must perform for a transition. The machine itself does no I/O. */
export type VoiceEffect =
  | 'open_microphone'
  | 'close_microphone'
  | 'begin_transcription'
  | 'abort_transcription'
  | 'begin_speech'
  | 'stop_speech';

export interface VoiceSnapshot {
  state: VoiceState;
  /** Increments whenever a new listening/speaking session starts or the current one is interrupted. */
  epoch: number;
  error?: string;
}

export type Transition =
  | { ok: true; snapshot: VoiceSnapshot; effects: VoiceEffect[] }
  | { ok: false; reason: 'stale' | 'invalid'; snapshot: VoiceSnapshot };

type Listener = (snapshot: VoiceSnapshot, effects: VoiceEffect[]) => void;

export class VoiceStateMachine {
  private snap: VoiceSnapshot = { state: 'IDLE', epoch: 0 };
  private readonly listeners = new Set<Listener>();

  get snapshot(): VoiceSnapshot {
    return this.snap;
  }

  get state(): VoiceState {
    return this.snap.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(action: VoiceAction): Transition {
    const result = this.next(action);
    if (result.ok) {
      this.snap = result.snapshot;
      for (const listener of this.listeners) listener(result.snapshot, result.effects);
    }
    return result;
  }

  private next(action: VoiceAction): Transition {
    const { state, epoch } = this.snap;
    const ok = (
      nextState: VoiceState,
      effects: VoiceEffect[],
      bump = false,
      error?: string,
    ): Transition => ({
      ok: true,
      snapshot: {
        state: nextState,
        epoch: bump ? epoch + 1 : epoch,
        ...(error !== undefined ? { error } : {}),
      },
      effects,
    });
    const refuse = (reason: 'stale' | 'invalid'): Transition => ({
      ok: false,
      reason,
      snapshot: this.snap,
    });

    // Completions from an older session are dropped, whatever state we are in now.
    if (
      (action.type === 'transcribed' ||
        action.type === 'finished_speaking' ||
        action.type === 'fail') &&
      action.epoch !== epoch
    ) {
      return refuse('stale');
    }

    switch (action.type) {
      case 'interrupt':
        return ok('IDLE', interruptEffects(state), state !== 'IDLE');
      case 'reset':
        return ok('IDLE', interruptEffects(state), state !== 'IDLE');
      case 'start_listening':
        if (state === 'LISTENING') return refuse('invalid');
        // Barge-in: speaking or processing is abandoned so the user can speak.
        return ok('LISTENING', [...interruptEffects(state), 'open_microphone'], true);
      case 'stop_listening':
        return state === 'LISTENING'
          ? ok('PROCESSING', ['close_microphone', 'begin_transcription'])
          : refuse('invalid');
      case 'transcribed':
        return state === 'PROCESSING' ? ok('IDLE', []) : refuse('invalid');
      case 'start_speaking':
        // Never talk over the user, and never start speech while a transcript is pending.
        return state === 'IDLE' || state === 'ERROR'
          ? ok('SPEAKING', ['begin_speech'], true)
          : refuse('invalid');
      case 'finished_speaking':
        return state === 'SPEAKING' ? ok('IDLE', []) : refuse('invalid');
      case 'fail':
        if (state === 'IDLE') return refuse('invalid');
        return ok('ERROR', interruptEffects(state), false, action.message);
    }
  }
}

function interruptEffects(state: VoiceState): VoiceEffect[] {
  switch (state) {
    case 'LISTENING':
      return ['close_microphone'];
    case 'PROCESSING':
      return ['abort_transcription'];
    case 'SPEAKING':
      return ['stop_speech'];
    default:
      return [];
  }
}
