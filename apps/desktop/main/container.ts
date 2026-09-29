import {
  ConversationRepository,
  FileBookmarkRepository,
  FileOperationRepository,
  PermissionRepository,
  ToolAuditRepository,
  openDatabase,
  ProviderRepository,
  SettingsRepository,
  type DatabaseHandle,
} from '@allaya/database';
import { CredentialVault, type Cipher, type CredentialStore } from '@allaya/security';
import { RunRegistry, newId, type Logger } from '@allaya/shared';
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
  /** Extra tools to register (each later phase supplies its own; E2E adds harmless test tools). */
  extraTools?: ToolDefinition[];
  /** How long an unanswered confirmation stays open. Tests shorten it. */
  confirmationTimeoutMs?: number;
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
  const tools = new ToolService({
    permissions,
    audit: new ToolAuditRepository(database.db),
    events,
    logger: options.logger.child('tools'),
    tools: [...computerTools, ...fileTools, ...(options.extraTools ?? [])],
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

  const chat = new ChatService({
    conversations: new ConversationRepository(database.db),
    providers,
    settings,
    tools,
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
    permissions,
    runs,
    events,
    registry,
    logger: options.logger,
    dispose: () => {
      runs.cancelAll('shutdown');
      database.close();
    },
  };
}
