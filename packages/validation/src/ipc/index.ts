import type { z } from 'zod';
import { activityContract } from './activity';
import { agentContract } from './agent';
import { appsContract } from './apps';
import { automationsContract } from './automations';
import { appContract } from './app';
import { browserContract } from './browser';
import { chatContract } from './chat';
import { diagnosticsContract } from './diagnostics';
import { computerContract } from './computer';
import { filesContract } from './files';
import { memoryContract } from './memory';
import { providersContract } from './providers';
import { tasksContract } from './tasks';
import { shellContract } from './shell';
import { skillsContract } from './skills';
import { toolsContract } from './tools';
import { updatesContract } from './updates';
import { voiceContract } from './voice';
import type { ChannelSpec, IpcResult } from './common';

export * from './common';
export * from './app';
export * from './activity';
export * from './agent';
export * from './providers';
export * from './chat';
export * from './diagnostics';
export * from './voice';
export * from './tools';
export * from './computer';
export * from './files';
export * from './browser';
export * from './tasks';
export * from './apps';
export * from './automations';
export * from './shell';
export * from './updates';
export * from './memory';
export * from './skills';

/**
 * The complete IPC surface between renderer and main. Each domain contributes
 * `invoke` (request/response) and `events` (main → renderer push) channels.
 * This object is the single source of truth: the preload allow-list, the main-process
 * dispatcher, and the renderer's typed client are all derived from it.
 */
export const ipcInvokeContract = {
  ...appContract.invoke,
  ...agentContract.invoke,
  ...activityContract.invoke,
  ...providersContract.invoke,
  ...chatContract.invoke,
  ...voiceContract.invoke,
  ...toolsContract.invoke,
  ...computerContract.invoke,
  ...filesContract.invoke,
  ...browserContract.invoke,
  ...tasksContract.invoke,
  ...automationsContract.invoke,
  ...diagnosticsContract.invoke,
  ...appsContract.invoke,
  ...memoryContract.invoke,
  ...skillsContract.invoke,
  ...shellContract.invoke,
  ...updatesContract.invoke,
} as const satisfies Record<string, ChannelSpec>;

export const ipcEventContract = {
  ...appContract.events,
  ...agentContract.events,
  ...activityContract.events,
  ...providersContract.events,
  ...chatContract.events,
  ...voiceContract.events,
  ...toolsContract.events,
  ...computerContract.events,
  ...filesContract.events,
  ...browserContract.events,
  ...tasksContract.events,
  ...automationsContract.events,
  ...memoryContract.events,
  ...skillsContract.events,
  ...shellContract.events,
  ...updatesContract.events,
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
