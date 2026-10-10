import type { FetchLike } from '@allaya/ai';
import type { Cipher } from '@allaya/security';
import { ChatService } from '@lite/main/core/chat';
import { ConnectionService } from '@lite/main/core/connections';
import { openDb, type Db } from '@lite/main/core/db';
import { Events, MemorySink } from '@lite/main/core/events';
import { SecretStore } from '@lite/main/core/secrets';
import { BrowserService } from '@lite/main/browser/service';
import { createBrowserTools } from '@lite/main/browser/tools';
import { SettingsStore } from '@lite/main/core/settings';
import { ApprovalService, approverForChat } from '@lite/main/core/approvals';
import { TaskService } from '@lite/main/core/tasks';
import { McpService, type McpHost } from '@lite/main/mcp/service';
import { createTaskTools } from '@lite/main/core/task-tools';
import type { RunView } from '@lite/shared/ipc';
import { VoiceService } from '@lite/main/core/voice';
import { ToolRegistry } from '@lite/main/core/tools';
import { FakeBrowser } from './fake-browser';
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
  /** Answer questions on the spot instead of leaving them open (for tests that do not look at the question). */
  approve?: (request: ApprovalRequest & { chatId: string }) => Promise<boolean>;
  now?: () => Date;
  /** What opening the person's browser does (for signing in). */
  openBrowser?: McpHost['openBrowser'];
  signInTimeoutMs?: number;
}

export interface LiteBackend {
  db: Db;
  events: MemorySink;
  settings: SettingsStore;
  secrets: SecretStore;
  connections: ConnectionService;
  chat: ChatService;
  voice: VoiceService;
  tools: ToolRegistry;
  browser: FakeBrowser;
  tasks: TaskService;
  approvals: ApprovalService;
  mcp: McpService;
  /** Every run that ended, as the desktop notice would have been told. */
  finished: RunView[];
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
  const browser = new FakeBrowser();
  const tools = new ToolRegistry();
  for (const tool of createBrowserTools(browser)) tools.register(tool);
  const approvals = new ApprovalService(
    events,
    options.now ? { now: () => options.now!().getTime() } : {},
  );
  const mcp = new McpService({
    db,
    secrets,
    events,
    tools,
    host: { openBrowser: options.openBrowser ?? (() => Promise.resolve()) },
    ...(options.signInTimeoutMs ? { signInTimeoutMs: options.signInTimeoutMs } : {}),
  });
  const finished: RunView[] = [];
  const tasks = new TaskService({
    db,
    beforeRun: (groups) => mcp.ensure(groups),
    connections,
    settings,
    events,
    tools,
    approvals,
    onFinished: (run) => finished.push(run),
    ...(options.now ? { now: options.now } : {}),
  });
  for (const tool of createTaskTools(tasks, options.now ?? (() => new Date()), () => mcp.groups()))
    tools.register(tool);
  const chat = new ChatService({
    db,
    connections,
    settings,
    events,
    tools,
    approve: options.approve ?? approverForChat(approvals),
    ...(options.now ? { now: options.now } : {}),
  });
  const voice = new VoiceService({ settings, connections });
  const handlers = createHandlers({
    settings,
    connections,
    chat,
    voice,
    browser: new BrowserService(browser),
    tasks,
    approvals,
    mcp,
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
    voice,
    tools,
    browser,
    tasks,
    approvals,
    mcp,
    finished,
    call: (channel, payload) => dispatcher.dispatch({ channel, payload }, TRUSTED),
    dispose: () => {
      void mcp.dispose();
      db.close();
    },
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
