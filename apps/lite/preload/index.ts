import { contextBridge, ipcRenderer } from 'electron';
import {
  isEventChannel,
  isInvokeChannel,
  type Bridge,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  type IpcResult,
} from '../shared/ipc';

const INVOKE = 'allaya:invoke';
const EVENT = 'allaya:event';

type Listener = (payload: unknown) => void;
const listeners = new Map<EventChannel, Set<Listener>>();

ipcRenderer.on(EVENT, (_event, message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const { channel, payload } = message as { channel?: unknown; payload?: unknown };
  if (typeof channel !== 'string' || !isEventChannel(channel)) return;
  for (const listener of listeners.get(channel) ?? []) listener(payload);
});

/**
 * The only thing the screen can reach: two functions, limited to the channels in the contract. It carries no Node.js,
 * Electron or file access. The engine checks every call again; this list only fails fast.
 */
const api: Bridge = {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: unknown[]
  ): Promise<IpcResult<InvokeResponse<C>>> {
    if (!isInvokeChannel(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown channel', retryable: false },
      });
    }
    const payload = args[0] as InvokeRequest<C> | undefined;
    return ipcRenderer.invoke(INVOKE, { channel, payload }) as Promise<
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
