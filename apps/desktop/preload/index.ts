import { contextBridge, ipcRenderer } from 'electron';
import {
  isEventChannel,
  isInvokeChannel,
  type AllayaBridge,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  type IpcResult,
} from '@allaya/validation';

const INVOKE_CHANNEL = 'allaya:invoke';
const EVENT_CHANNEL = 'allaya:event';

type Listener = (payload: unknown) => void;
const listeners = new Map<EventChannel, Set<Listener>>();

ipcRenderer.on(EVENT_CHANNEL, (_event, message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const { channel, payload } = message as { channel?: unknown; payload?: unknown };
  if (typeof channel !== 'string' || !isEventChannel(channel)) return;
  for (const listener of listeners.get(channel) ?? []) listener(payload);
});

/**
 * The only surface exposed to the renderer. It carries no Node.js, Electron or filesystem
 * capability — just two functions restricted to channels declared in the shared contract.
 * Main re-validates everything; this allow-list is fast-fail, not the security boundary.
 */
const api: AllayaBridge = {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: unknown[]
  ): Promise<IpcResult<InvokeResponse<C>>> {
    const payload = args[0] as InvokeRequest<C> | undefined;
    if (!isInvokeChannel(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown channel', retryable: false },
      });
    }
    return ipcRenderer.invoke(INVOKE_CHANNEL, { channel, payload }) as Promise<
      IpcResult<InvokeResponse<C>>
    >;
  },

  subscribe<E extends EventChannel>(
    channel: E,
    listener: (payload: EventPayload<E>) => void,
  ): () => void {
    if (!isEventChannel(channel)) return () => undefined;
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(listener as Listener);
    return () => {
      set.delete(listener as Listener);
    };
  },
};

contextBridge.exposeInMainWorld('allaya', api);
