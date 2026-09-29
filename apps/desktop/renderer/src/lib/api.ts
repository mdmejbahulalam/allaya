import type { AllayaError } from '@allaya/shared';
import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
} from '@allaya/validation';

/** A failed IPC call. `code` is stable and maps to a localized message in the UI. */
export class IpcError extends Error {
  readonly code: AllayaError['code'];
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(error: {
    code: AllayaError['code'];
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  }) {
    super(error.message);
    this.name = 'IpcError';
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.details) this.details = error.details;
  }
}

/**
 * Typed client over `window.allaya`. Resolves with data or throws `IpcError`,
 * which is what TanStack Query expects from a query/mutation function.
 */
export async function invoke<C extends InvokeChannel>(
  channel: C,
  ...payload: InvokeRequest<C> extends undefined
    ? [payload?: undefined]
    : [payload: InvokeRequest<C>]
): Promise<InvokeResponse<C>> {
  const bridge = window.allaya;
  const result = await bridge.invoke(channel, ...payload);
  if (!result.ok) throw new IpcError(result.error);
  return result.data;
}

export function subscribe<E extends EventChannel>(
  channel: E,
  listener: (payload: EventPayload<E>) => void,
): () => void {
  return window.allaya.subscribe(channel, listener);
}
