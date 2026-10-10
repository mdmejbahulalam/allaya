import type { FetchLike } from '@allaya/ai';
import type { Cipher } from '@allaya/security';
import { ChatService } from '@lite/main/core/chat';
import { ConnectionService } from '@lite/main/core/connections';
import { openDb, type Db } from '@lite/main/core/db';
import { Events, MemorySink } from '@lite/main/core/events';
import { SecretStore } from '@lite/main/core/secrets';
import { SettingsStore } from '@lite/main/core/settings';
import { ToolRegistry } from '@lite/main/core/tools';
import type { ApprovalRequest } from '@lite/main/core/agent';
import { Dispatcher } from '@lite/main/ipc/dispatcher';
import { createHandlers } from '@lite/main/ipc/handlers';
import type { InvokeChannel, InvokeRequest } from '@lite/shared/ipc';
import { FakeCipher } from '../../helpers/cipher';

export interface LiteBackendOptions {
  fetch?: FetchLike;
  cipher?: Cipher;
  db?: Db;
  baseUrlOverrides?: Record<string, string>;
  approve?: (request: ApprovalRequest & { chatId: string }) => Promise<boolean>;
  now?: () => Date;
}

export interface LiteBackend {
  db: Db;
  events: MemorySink;
  settings: SettingsStore;
  secrets: SecretStore;
  connections: ConnectionService;
  chat: ChatService;
  tools: ToolRegistry;
  /** Calls a channel as the app's own screen would, through the real dispatcher. */
  call<C extends InvokeChannel>(channel: C, payload?: InvokeRequest<C>): Promise<unknown>;
  dispose(): void;
}

const TRUSTED = { id: 1, frameUrl: 'allaya-lite://app/index.html', isMainFrame: true };

/** The whole engine in plain Node with an in-memory database, behind the same dispatcher the app uses. */
export function createLiteBackend(options: LiteBackendOptions = {}): LiteBackend {
  const db = options.db ?? openDb(':memory:');
  const events = new Events();
  const sink = new MemorySink();
  events.addSink(sink);
  const settings = new SettingsStore(db);
  const secrets = new SecretStore(db, options.cipher ?? new FakeCipher());
  const connections = new ConnectionService({
    db,
    secrets,
    events,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseUrlOverrides ? { baseUrlOverrides: options.baseUrlOverrides } : {}),
  });
  const tools = new ToolRegistry();
  const chat = new ChatService({
    db,
    connections,
    settings,
    events,
    tools,
    ...(options.approve ? { approve: options.approve } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const handlers = createHandlers({
    settings,
    connections,
    chat,
    info: { version: '0.0.0-test', platform: 'test', locale: 'en-US', e2e: false },
  });
  handlers.assertComplete();
  const dispatcher = new Dispatcher({ handlers, isTrusted: () => true });
  return {
    db,
    events: sink,
    settings,
    secrets,
    connections,
    chat,
    tools,
    call: (channel, payload) => dispatcher.dispatch({ channel, payload }, TRUSTED),
    dispose: () => db.close(),
  };
}

type Ok<T> = { ok: true; data: T };
export const data = <T>(result: unknown): T => (result as Ok<T>).data;
export const failure = (result: unknown) =>
  (
    result as {
      ok: false;
      error: { code: string; message: string; details?: Record<string, unknown> };
    }
  ).error;
