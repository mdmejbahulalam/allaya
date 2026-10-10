import type {
  Bridge,
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  SerializedError,
} from '../../../shared/ipc';

/** A call that failed. `code` is stable; the screen turns it into words in the person's language. */
export class IpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  constructor(error: SerializedError) {
    super(error.message);
    this.name = 'IpcError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

/**
 * The bridge the preload exposes. It is read through this one function rather than declared on `Window`, so this
 * app's type cannot clash with any other app's in the same repository.
 */
const bridge = (): Bridge => (window as unknown as { allaya: Bridge }).allaya;

/** Calls the engine. Resolves with the answer or throws `IpcError`. */
export async function invoke<C extends InvokeChannel>(
  channel: C,
  ...payload: InvokeRequest<C> extends undefined
    ? [payload?: undefined]
    : [payload: InvokeRequest<C>]
): Promise<InvokeResponse<C>> {
  const result = await bridge().invoke(channel, ...payload);
  if (!result.ok) throw new IpcError(result.error);
  return result.data;
}

export function subscribe<E extends EventChannel>(
  channel: E,
  listener: (payload: EventPayload<E>) => void,
): () => void {
  return bridge().subscribe(channel, listener);
}
