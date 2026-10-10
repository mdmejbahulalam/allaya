import { EnergyVad, rms, type VadOptions } from '@allaya/speech';

export type RecordingFailure = 'permission_denied' | 'no_microphone' | 'unsupported' | 'failed';

/** A recording that could not start. `reason` maps to a localized message. */
export class RecorderError extends Error {
  constructor(
    readonly reason: RecordingFailure,
    cause?: unknown,
  ) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = 'RecorderError';
  }
}

export type RecordingResult =
  | { kind: 'audio'; blob: Blob; mimeType: string; durationMs: number; speechDetected: boolean }
  | { kind: 'no_speech' }
  | { kind: 'cancelled' };

export interface RecorderOptions {
  /** Empty string = system default microphone. */
  deviceId?: string;
  /** Called ~20×/s with the current level (0..1) for the visualizer. */
  onLevel?: (level: number) => void;
  /** End the recording by itself after the speaker stops. */
  autoStop?: boolean;
  vad?: Partial<VadOptions>;
}

export interface RecorderHandle {
  /** Resolves once, when recording ends for any reason. */
  finished: Promise<RecordingResult>;
  /** Finish now and deliver what was recorded. */
  stop(): void;
  /** Finish now and throw the audio away. */
  cancel(): void;
}

const FRAME_MS = 50;
/** A manual stop before this much audio has been captured is treated as "nothing said". */
const MIN_MANUAL_MS = 400;
const HARD_CAP_MS = 60_000;
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Captures microphone audio with voice-activity detection. The audio never leaves memory here: it is handed to
 * the caller as a Blob, sent to the trusted main process, and dropped.
 */
export async function startRecording(options: RecorderOptions = {}): Promise<RecorderHandle> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new RecorderError('unsupported');
  }
  const mimeType = pickMimeType();
  if (!mimeType) throw new RecorderError('unsupported');

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError')
      throw new RecorderError('permission_denied', error);
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      throw new RecorderError('no_microphone', error);
    throw new RecorderError('failed', error);
  }

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const vad = new EnergyVad(options.vad);
  const startedAt = performance.now();
  let speechDetected = false;
  let settled = false;
  let resolveFinished!: (result: RecordingResult) => void;
  const finished = new Promise<RecordingResult>((resolve) => {
    resolveFinished = resolve;
  });

  const release = () => {
    clearInterval(timer);
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };

  const finish = (mode: 'deliver' | 'discard' | 'no_speech') => {
    if (settled) return;
    settled = true;
    const durationMs = performance.now() - startedAt;
    const done = () => {
      release();
      if (mode === 'discard') resolveFinished({ kind: 'cancelled' });
      else if (mode === 'no_speech' || chunks.length === 0) resolveFinished({ kind: 'no_speech' });
      else
        resolveFinished({
          kind: 'audio',
          blob: new Blob(chunks, { type: mimeType }),
          mimeType,
          durationMs,
          speechDetected,
        });
    };
    if (recorder.state === 'inactive') done();
    else {
      recorder.onstop = done;
      recorder.stop();
    }
  };

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    const level = Math.min(1, rms(samples) * 6); // visual gain: speech is rarely above 0.2 RMS
    options.onLevel?.(level);
    const event = vad.push(rms(samples), FRAME_MS);
    if (event?.type === 'speech_start') speechDetected = true;
    if (options.autoStop !== false) {
      if (event?.type === 'speech_end') finish('deliver');
      else if (event?.type === 'no_speech') finish('no_speech');
    }
    if (performance.now() - startedAt > HARD_CAP_MS) finish('deliver');
  }, FRAME_MS);

  recorder.start(250);

  return {
    finished,
    stop: () => finish(performance.now() - startedAt < MIN_MANUAL_MS ? 'no_speech' : 'deliver'),
    cancel: () => finish('discard'),
  };
}

/** Blob → base64 without holding a second full copy as a string of bytes. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
