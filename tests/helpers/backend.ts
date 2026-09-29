import { sourceMigrationsFolder } from '@allaya/database';
import { MemorySink, StructuredLogger, type Logger } from '@allaya/shared';
import type { AppInfo } from '@allaya/validation';
import { createContainer, type Container } from '@main/container';
import { IpcDispatcher, type SenderInfo } from '@main/ipc/dispatcher';
import { MemoryEventSink } from '@main/ipc/events';

export const TRUSTED_URL = 'file:///app/renderer/index.html';

export const trustedSender: SenderInfo = { id: 1, frameUrl: TRUSTED_URL, isMainFrame: true };

export const testAppInfo: AppInfo = {
  name: 'Allaya',
  version: '0.0.0-test',
  electronVersion: '0',
  chromeVersion: '0',
  nodeVersion: process.versions.node,
  platform: process.platform,
  osVersion: 'test',
  arch: process.arch,
  osLocale: 'en-US',
  isPackaged: false,
  environment: 'development',
};

export interface TestBackend {
  container: Container;
  dispatcher: IpcDispatcher;
  events: MemoryEventSink;
  logs: MemorySink;
  logger: Logger;
  call(
    channel: string,
    payload?: unknown,
    sender?: SenderInfo,
  ): ReturnType<IpcDispatcher['dispatch']>;
  dispose(): void;
}

/** Builds the whole trusted backend in plain Node with an in-memory database. */
export function createTestBackend(): TestBackend {
  const logs = new MemorySink();
  const logger = new StructuredLogger([logs], 'test', 'DEBUG');
  const container = createContainer({
    databasePath: ':memory:',
    migrationsFolder: sourceMigrationsFolder(),
    logger,
    getAppInfo: () => testAppInfo,
    strict: true,
  });
  container.registry.assertComplete();
  const events = new MemoryEventSink();
  container.events.addSink(events);
  const dispatcher = new IpcDispatcher({
    registry: container.registry,
    logger,
    validateResponses: true,
    isTrustedSender: (sender) => sender.frameUrl === TRUSTED_URL,
  });
  return {
    container,
    dispatcher,
    events,
    logs,
    logger,
    call: (channel, payload, sender = trustedSender) =>
      dispatcher.dispatch({ channel, payload }, sender),
    dispose: () => container.dispose(),
  };
}
