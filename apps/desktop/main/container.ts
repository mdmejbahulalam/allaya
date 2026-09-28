import { openDatabase, SettingsRepository, type DatabaseHandle } from '@allaya/database';
import type { AppInfo } from '@allaya/validation';
import type { Logger } from '@allaya/shared';
import { EventPublisher } from './ipc/events';
import { HandlerRegistry } from './ipc/registry';
import { registerAppHandlers } from './ipc/handlers/app';
import { SettingsService } from './services/settings-service';

export interface ContainerOptions {
  databasePath: string;
  migrationsFolder: string;
  logger: Logger;
  getAppInfo: () => AppInfo;
  /** Strict response/event validation (enabled outside production). */
  strict: boolean;
}

/**
 * Composition root. Constructs every trusted service exactly once and wires them
 * together. It has no Electron imports, so integration tests can build the full
 * backend in plain Node.
 */
export interface Container {
  database: DatabaseHandle;
  settings: SettingsService;
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
  settings.events.on('changed', (snapshot) => events.publish('settings:changed', snapshot));

  const registry = new HandlerRegistry();
  registerAppHandlers(registry, { settings, getAppInfo: options.getAppInfo });

  return {
    database,
    settings,
    events,
    registry,
    logger: options.logger,
    dispose: () => database.close(),
  };
}
