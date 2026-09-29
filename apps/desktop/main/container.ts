import {
  ConversationRepository,
  FileBookmarkRepository,
  FileOperationRepository,
  PermissionRepository,
  ToolAuditRepository,
  openDatabase,
  ProviderRepository,
  SettingsRepository,
  TaskRepository,
  AutomationRepository,
  type DatabaseHandle,
} from '@allaya/database';
import { CredentialVault, type Cipher, type CredentialStore } from '@allaya/security';
import { AllayaError, RunRegistry, newId, type Logger } from '@allaya/shared';
import type { ProviderId } from '@allaya/types';
import type { AppInfo } from '@allaya/validation';
import type { ProviderFactoryOptions } from '@allaya/ai';
import {
  CompositeAdapter,
  ComputerEngine,
  createComputerTools,
  type ScreenshotStore,
} from '@allaya/computer';
import {
  BrowserEngine,
  PlaywrightSession,
  SafeProxy,
  UrlPolicy,
  createBrowserTools,
  findBrowser,
  type BrowserSession,
  type FoundBrowser,
  type UrlPolicyOptions,
} from '@allaya/browser';
import {
  AppTrash,
  FileManager,
  PathPolicy,
  createFileTools,
  type KnownFolderId,
  type TrashProvider,
} from '@allaya/filesystem';
import type { ToolDefinition } from '@allaya/tools';
import { DbJournal } from './files/db-journal';
import { FolderRoots } from './files/folder-roots';
import { FileService } from './services/file-service';
import { registerFileHandlers } from './ipc/handlers/files';
import { registerBrowserHandlers } from './ipc/handlers/browser';
import { registerTaskHandlers } from './ipc/handlers/tasks';
import { registerAutomationHandlers } from './ipc/handlers/automations';
import { AutomationService } from './services/automation-service';
import { DbAutomationStore } from './automation/db-store';
import { createAutomationTools } from '@allaya/automation';
import { TaskService, type TaskServiceDeps } from './services/task-service';
import { BrowserService, type BrowserLaunchState } from './services/browser-service';
import { EventPublisher } from './ipc/events';
import { HandlerRegistry } from './ipc/registry';
import { registerAgentHandlers } from './ipc/handlers/agent';
import { registerAppHandlers } from './ipc/handlers/app';
import { registerChatHandlers } from './ipc/handlers/chat';
import { registerProviderHandlers } from './ipc/handlers/providers';
import { registerComputerHandlers } from './ipc/handlers/computer';
import { registerToolHandlers } from './ipc/handlers/tools';
import { registerVoiceHandlers } from './ipc/handlers/voice';
import { ChatService } from './services/chat-service';
import { ProviderService } from './services/provider-service';
import { ComputerService } from './services/computer-service';
import { PermissionService } from './services/permission-service';
import { SettingsService } from './services/settings-service';
import { ToolService } from './services/tool-service';
import { VoiceService } from './services/voice-service';

const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ContainerOptions {
  databasePath: string;
  migrationsFolder: string;
  logger: Logger;
  getAppInfo: () => AppInfo;
  /** OS-backed encryption for API keys. */
  cipher: Cipher;
  /** Strict response/event validation (enabled outside production). */
  strict: boolean;
  /** Test seam: fake `fetch`, base URLs, timeouts. Never set in production. */
  providerOptions?: Partial<Omit<ProviderFactoryOptions, 'getApiKey'>>;
  /** Computer control for this machine. Omitted in tests that do not touch the desktop (then none is offered). */
  computer?: { engine: ComputerEngine; screenshots?: ScreenshotStore & { folder?: string } };
  /**
   * File access. Omitted in tests that do not touch files (then the model is offered no file tools). Everything
   * that needs Electron (the Recycle Bin, opening, the folder picker) is passed in, so this stays testable.
   */
  files?: {
    /** Where the OS's known folders are. Only these, plus folders the user adds, are ever reachable. */
    knownFolders: Partial<Record<KnownFolderId, string>>;
    /** Allaya's own data folder, and anything else that must never be touched. */
    protectedPaths: string[];
    home: string;
    /** Holds previous versions of overwritten files. */
    backupsFolder: string;
    /** Where deletes go. */
    trash: TrashProvider;
    opener?: (absolutePath: string) => Promise<void>;
    pickFolder?: (title: string) => Promise<string | undefined>;
    reveal?: (absolutePath: string) => void;
  };
  /**
   * The browser Allaya may drive. Omitted in tests that do not browse (then the model is offered no browser tools).
   * The browser itself is started only when something first needs it.
   */
  browser?: {
    /** Allaya's own browser profile (cookies, sign-ins): never the person's everyday profile. */
    profileDir: string;
    /** Which installed browser to drive. Defaults to Edge, then Chrome, in their standard folders. */
    discover?: () => FoundBrowser | undefined;
    /** Only for containers where Chromium cannot use its sandbox (running as root). */
    noSandbox?: boolean;
    /** Test seam: a scripted browser in place of Chromium. */
    createSession?: (headless: boolean, policy: UrlPolicy) => Promise<BrowserSession>;
    /** Test seam: lets named fixture hosts reach this machine, and decides how names resolve. */
    policyOptions?: Pick<UrlPolicyOptions, 'allowHosts' | 'resolve'>;
    /** Force a hidden browser regardless of the setting (test runs). */
    forceHeadless?: boolean;
  };
  /** Extra tools to register (each later phase supplies its own; E2E adds harmless test tools). */
  extraTools?: ToolDefinition[];
  /** How long an unanswered confirmation stays open. Tests shorten it. */
  confirmationTimeoutMs?: number;
  /** Test seam for the task engine: tighter limits, no waiting between retries. */
  tasks?: Pick<TaskServiceDeps, 'limits' | 'backoffMs'>;
  /** Test seam: the scheduler's clock and whether it starts its own timer (tests drive `tick()` themselves). */
  automations?: { now?: () => number; autoStart?: boolean };
}

/**
 * Composition root. Constructs every trusted service exactly once and wires them together. It has no
 * Electron imports, so integration tests can build the full backend in plain Node.
 */
export interface Container {
  database: DatabaseHandle;
  settings: SettingsService;
  providers: ProviderService;
  chat: ChatService;
  voice: VoiceService;
  tools: ToolService;
  computer: ComputerService;
  files: FileService;
  browser: BrowserService;
  tasks: TaskService;
  automations: AutomationService;
  permissions: PermissionService;
  runs: RunRegistry;
  events: EventPublisher;
  registry: HandlerRegistry;
  logger: Logger;
  dispose(): void;
}

export function createContainer(options: ContainerOptions): Container {
  const database = openDatabase({
    path: options.databasePath,
    migrationsFolder: options.migrationsFolder,
  });

  const settings = new SettingsService(new SettingsRepository(database.db));
  const events = new EventPublisher({ validate: options.strict, logger: options.logger });
  const runs = new RunRegistry();

  const providerRepo = new ProviderRepository(database.db);
  const credentialStore: CredentialStore = {
    get: (id) => {
      const row = providerRepo.getCredential(id);
      return row ? { encryptedKey: row.encryptedKey, maskedHint: row.maskedHint } : undefined;
    },
    put: (id: ProviderId, encryptedKey, maskedHint) =>
      providerRepo.upsertCredential(id, encryptedKey, maskedHint),
    delete: (id) => providerRepo.deleteCredential(id),
  };
  const vault = new CredentialVault(credentialStore, options.cipher);
  const providers = new ProviderService({
    repo: providerRepo,
    vault,
    settings,
    logger: options.logger.child('providers'),
    ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
  });

  const permissions = new PermissionService(new PermissionRepository(database.db));
  // No computer configured ⇒ an engine with no capabilities, so the model is offered no computer tools at all.
  const engine =
    options.computer?.engine ??
    new ComputerEngine({ adapter: new CompositeAdapter(undefined, undefined) });
  const computerTools = createComputerTools(engine, options.computer?.screenshots);
  const computer = new ComputerService({
    engine,
    tools: computerTools,
    ...(options.computer?.screenshots ? { screenshots: options.computer.screenshots } : {}),
    logger: options.logger.child('computer'),
  });
  // File access: known folders + user-added folders, one guard for the model and for the Files screen.
  let fileManager: FileManager | undefined;
  let fileTools: ToolDefinition[] = [];
  let folderRoots: FolderRoots | undefined;
  const bookmarks = new FileBookmarkRepository(database.db);
  if (options.files) {
    const files = options.files;
    folderRoots = new FolderRoots(files.knownFolders, bookmarks);
    const roots = folderRoots;
    const journal = new DbJournal(new FileOperationRepository(database.db), (entry) => {
      events.publish('files:changed', {});
      const shown = entry?.target ?? entry?.label;
      if (entry && entry.kind !== 'trash' && shown) {
        bookmarks.touchRecent(newId('rec'), shown.split('/').at(-1) ?? shown, shown);
      }
    });
    const backups = new AppTrash(files.backupsFolder);
    // Previous versions of overwritten files are kept for a month, then removed.
    void backups.purge(BACKUP_RETENTION_MS).catch(() => undefined);
    fileManager = new FileManager({
      policy: new PathPolicy({ roots: () => roots.list(), protectedPaths: files.protectedPaths }),
      trash: files.trash,
      backups,
      journal,
      warn: (message, error) =>
        options.logger.child('files').warn(message, { error: String(error) }),
      ...(files.opener ? { opener: files.opener } : {}),
    });
    fileTools = createFileTools(fileManager);
  }
  // Browser: one URL policy shared by the engine (checks before navigating) and the network proxy (checks every
  // connection the browser makes), reading the user's trusted/blocked lists live.
  const launchState: BrowserLaunchState = { forceHeaded: false, headless: true };
  const browserOptions = options.browser;
  const urlPolicy = new UrlPolicy({
    blocked: () => settings.get('browser.blockedDomains'),
    trusted: () => settings.get('browser.trustedDomains'),
    ...(browserOptions?.policyOptions ?? {}),
  });
  const discover = browserOptions?.discover ?? (() => findBrowser());
  const proxy = new SafeProxy({ policy: urlPolicy });
  const browserEngine = new BrowserEngine({
    policy: urlPolicy,
    session: async () => {
      if (!browserOptions) {
        throw new AllayaError('The browser is not available here', {
          code: 'UNSUPPORTED_PLATFORM',
        });
      }
      const headless =
        browserOptions.forceHeadless === true
          ? true
          : launchState.forceHeaded
            ? false
            : settings.get('browser.headless');
      launchState.headless = headless;
      if (browserOptions.createSession) return browserOptions.createSession(headless, urlPolicy);
      const found = discover();
      if (!found) {
        throw new AllayaError(
          'No compatible browser was found. Install Microsoft Edge or Google Chrome to let Allaya browse.',
          { code: 'UNSUPPORTED_PLATFORM' },
        );
      }
      await proxy.start();
      return PlaywrightSession.launch({
        profileDir: browserOptions.profileDir,
        executablePath: found.path,
        proxy,
        headless,
        ...(browserOptions.noSandbox ? { noSandbox: true } : {}),
      });
    },
  });
  const browserTools = browserOptions
    ? createBrowserTools(browserEngine, options.computer?.screenshots)
    : [];
  const browser = new BrowserService({
    engine: browserEngine,
    settings,
    engineKind: () =>
      browserOptions?.createSession
        ? 'chromium'
        : browserOptions
          ? (discover()?.kind ?? undefined)
          : undefined,
    tools: browserTools,
    launch: launchState,
    profileFolder: browserOptions?.profileDir ?? '',
    logger: options.logger.child('browser'),
  });
  browserEngine.onChange(() => events.publish('browser:changed', {}));
  // The automation tools are registered with the other tools, but the service they call is built later (it needs the
  // task engine, which needs the tools): they reach it through this reference.
  const automationRef: { current?: AutomationService } = {};
  const automationService = () => {
    if (!automationRef.current) {
      throw new AllayaError('Automations are not ready yet', { code: 'INTERNAL' });
    }
    return automationRef.current;
  };
  const automationTools = createAutomationTools({
    create: (input) => automationService().createForTool(input),
    get: (id) => automationService().summary(id),
    list: () => automationService().summaries(),
  });
  const tools = new ToolService({
    permissions,
    audit: new ToolAuditRepository(database.db),
    events,
    logger: options.logger.child('tools'),
    tools: [
      ...computerTools,
      ...fileTools,
      ...browserTools,
      ...automationTools,
      ...(options.extraTools ?? []),
    ],
    ...(options.confirmationTimeoutMs !== undefined
      ? { confirmationTimeoutMs: options.confirmationTimeoutMs }
      : {}),
  });

  const fileService = new FileService({
    manager: fileManager,
    roots: folderRoots,
    bookmarks,
    tools,
    permissions,
    runs,
    settings,
    osLocale: () => options.getAppInfo().osLocale,
    logger: options.logger.child('files'),
    home: options.files?.home ?? '',
    ...(options.files?.pickFolder ? { pickFolder: options.files.pickFolder } : {}),
    ...(options.files?.reveal ? { reveal: options.files.reveal } : {}),
  });

  const conversations = new ConversationRepository(database.db);
  const tasks = new TaskService({
    repo: new TaskRepository(database.db),
    conversations,
    providers,
    tools,
    permissions,
    settings,
    events,
    runs,
    logger: options.logger.child('tasks'),
    osLocale: () => options.getAppInfo().osLocale,
    ...(options.tasks?.limits ? { limits: options.tasks.limits } : {}),
    ...(options.tasks?.backoffMs ? { backoffMs: options.tasks.backoffMs } : {}),
  });
  tasks.recover();
  const automations = new AutomationService({
    store: new DbAutomationStore(new AutomationRepository(database.db)),
    tasks,
    files: fileService,
    settings,
    events,
    runs,
    logger: options.logger.child('automations'),
    ...(options.automations?.now ? { now: options.automations.now } : {}),
  });
  automationRef.current = automations;
  if (options.automations?.autoStart !== false) automations.start();
  const chat = new ChatService({
    conversations,
    providers,
    settings,
    tools,
    tasks,
    events,
    runs,
    logger: options.logger.child('chat'),
    osLocale: () => options.getAppInfo().osLocale,
  });
  chat.recoverInterrupted();
  const voice = new VoiceService({
    providers,
    settings,
    runs,
    logger: options.logger.child('voice'),
  });

  settings.events.on('changed', (snapshot) => events.publish('settings:changed', snapshot));
  providers.events.on('changed', (list) => events.publish('providers:changed', list));

  const registry = new HandlerRegistry();
  registerAppHandlers(registry, { settings, getAppInfo: options.getAppInfo });
  registerProviderHandlers(registry, providers);
  registerChatHandlers(registry, chat);
  registerVoiceHandlers(registry, voice);
  registerToolHandlers(registry, tools, permissions);
  registerComputerHandlers(registry, computer);
  registerFileHandlers(registry, fileService);
  registerBrowserHandlers(registry, browser);
  registerTaskHandlers(registry, tasks);
  registerAutomationHandlers(registry, automations);
  registerAgentHandlers(registry, runs);

  return {
    database,
    settings,
    providers,
    chat,
    voice,
    tools,
    computer,
    files: fileService,
    browser,
    tasks,
    automations,
    permissions,
    runs,
    events,
    registry,
    logger: options.logger,
    dispose: () => {
      // Tasks first: they are paused as interrupted (resumable), not cancelled by the general stop below.
      automations.stop();
      tasks.shutdown();
      runs.cancelAll('shutdown');
      void browserEngine.close().finally(() => proxy.stop());
      database.close();
    },
  };
}
