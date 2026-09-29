import type { z } from 'zod';
import { agentContract } from './agent';
import { appContract } from './app';
import { chatContract } from './chat';
import { providersContract } from './providers';
import type { ChannelSpec, IpcResult } from './common';

export * from './common';
export * from './app';
export * from './agent';
export * from './providers';
export * from './chat';

/**
 * The complete IPC surface between renderer and main. Each domain contributes
 * `invoke` (request/response) and `events` (main → renderer push) channels.
 * This object is the single source of truth: the preload allow-list, the main-process
 * dispatcher, and the renderer's typed client are all derived from it.
 */
export const ipcInvokeContract = {
  ...appContract.invoke,
  ...agentContract.invoke,
  ...providersContract.invoke,
  ...chatContract.invoke,
} as const satisfies Record<string, ChannelSpec>;

export const ipcEventContract = {
  ...appContract.events,
  ...agentContract.events,
  ...providersContract.events,
  ...chatContract.events,
} as const satisfies Record<string, z.ZodType>;

export type InvokeChannel = keyof typeof ipcInvokeContract;
export type EventChannel = keyof typeof ipcEventContract;

export type InvokeRequest<C extends InvokeChannel> = z.input<
  (typeof ipcInvokeContract)[C]['request']
>;
export type InvokeResponse<C extends InvokeChannel> = z.output<
  (typeof ipcInvokeContract)[C]['response']
>;
export type EventPayload<E extends EventChannel> = z.output<(typeof ipcEventContract)[E]>;

export const INVOKE_CHANNELS = Object.keys(ipcInvokeContract) as InvokeChannel[];
export const EVENT_CHANNELS = Object.keys(ipcEventContract) as EventChannel[];

export function isInvokeChannel(channel: string): channel is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(ipcInvokeContract, channel);
}
export function isEventChannel(channel: string): channel is EventChannel {
  return Object.prototype.hasOwnProperty.call(ipcEventContract, channel);
}

/** The object the preload exposes as `window.allaya`. Defined here so preload and renderer share one type. */
export interface AllayaBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...payload: InvokeRequest<C> extends undefined
      ? [payload?: undefined]
      : [payload: InvokeRequest<C>]
  ): Promise<IpcResult<InvokeResponse<C>>>;
  subscribe<E extends EventChannel>(
    channel: E,
    listener: (payload: EventPayload<E>) => void,
  ): () => void;
}
