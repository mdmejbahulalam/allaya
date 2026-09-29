import { sourceMigrationsFolder } from '@allaya/database';
import type { FetchLike } from '@allaya/ai';
import { MemorySink, StructuredLogger, type Logger } from '@allaya/shared';
import type { AppInfo } from '@allaya/validation';
import { createContainer, type Container } from '@main/container';
import { IpcDispatcher, type SenderInfo } from '@main/ipc/dispatcher';
import { MemoryEventSink } from '@main/ipc/events';
import { FakeCipher } from './cipher';

export const TRUSTED_URL = 'allaya-app://app/index.html';

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

export interface TestBackendOptions {
  /** Fake network for AI providers. */
  fetch?: FetchLike;
  /** Simulate a machine with no OS keyring. */
  cipherAvailable?: boolean;
  databasePath?: string;
}

export interface TestBackend {
  container: Container;
  dispatcher: IpcDispatcher;
  events: MemoryEventSink;
  logs: MemorySink;
  logger: Logger;
  cipher: FakeCipher;
  call(
    channel: string,
    payload?: unknown,
    sender?: SenderInfo,
  ): ReturnType<IpcDispatcher['dispatch']>;
  /** Events of one channel, in order. */
  eventsOf(channel: string): unknown[];
  dispose(): void;
}

/** Builds the whole trusted backend in plain Node with an in-memory database. */
export function createTestBackend(options: TestBackendOptions = {}): TestBackend {
  const logs = new MemorySink();
  const logger = new StructuredLogger([logs], 'test', 'DEBUG');
  const cipher = new FakeCipher(options.cipherAvailable ?? true);
  const container = createContainer({
    databasePath: options.databasePath ?? ':memory:',
    migrationsFolder: sourceMigrationsFolder(),
    logger,
    getAppInfo: () => testAppInfo,
    cipher,
    strict: true,
    providerOptions: {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      maxRetries: 0,
      backoffMs: 0,
    },
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
    cipher,
    call: (channel, payload, sender = trustedSender) =>
      dispatcher.dispatch({ channel, payload }, sender),
    eventsOf: (channel) => events.events.filter((e) => e.channel === channel).map((e) => e.payload),
    dispose: () => container.dispose(),
  };
}
