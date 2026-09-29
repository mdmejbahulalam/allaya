import {
  ConversationRepository,
  PermissionRepository,
  ToolAuditRepository,
  openDatabase,
  ProviderRepository,
  SettingsRepository,
  type DatabaseHandle,
} from '@allaya/database';
import { CredentialVault, type Cipher, type CredentialStore } from '@allaya/security';
import { RunRegistry, type Logger } from '@allaya/shared';
import type { ProviderId } from '@allaya/types';
import type { AppInfo } from '@allaya/validation';
import type { ProviderFactoryOptions } from '@allaya/ai';
import type { ToolDefinition } from '@allaya/tools';
import { EventPublisher } from './ipc/events';
import { HandlerRegistry } from './ipc/registry';
import { registerAgentHandlers } from './ipc/handlers/agent';
import { registerAppHandlers } from './ipc/handlers/app';
import { registerChatHandlers } from './ipc/handlers/chat';
import { registerProviderHandlers } from './ipc/handlers/providers';
import { registerToolHandlers } from './ipc/handlers/tools';
import { registerVoiceHandlers } from './ipc/handlers/voice';
import { ChatService } from './services/chat-service';
import { ProviderService } from './services/provider-service';
import { PermissionService } from './services/permission-service';
import { SettingsService } from './services/settings-service';
import { ToolService } from './services/tool-service';
import { VoiceService } from './services/voice-service';

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
  const tools = new ToolService({
    permissions,
    audit: new ToolAuditRepository(database.db),
    events,
    logger: options.logger.child('tools'),
    ...(options.extraTools ? { tools: options.extraTools } : {}),
    ...(options.confirmationTimeoutMs !== undefined
      ? { confirmationTimeoutMs: options.confirmationTimeoutMs }
      : {}),
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
  registerAgentHandlers(registry, runs);

  return {
    database,
    settings,
    providers,
    chat,
    voice,
    tools,
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
