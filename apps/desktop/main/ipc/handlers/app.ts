import type { HandlerRegistry } from '../registry';
import type { SettingsService } from '../../services/settings-service';
import type { AppInfo } from '@allaya/validation';

export interface AppHandlerDeps {
  settings: SettingsService;
  getAppInfo: () => AppInfo;
}

export function registerAppHandlers(registry: HandlerRegistry, deps: AppHandlerDeps): void {
  registry
    .register('app:getInfo', () => deps.getAppInfo())
    .register('settings:getAll', () => deps.settings.getAll())
    .register('settings:set', (update) => deps.settings.set(update))
    .register('settings:reset', ({ key }) => deps.settings.reset(key));
}
