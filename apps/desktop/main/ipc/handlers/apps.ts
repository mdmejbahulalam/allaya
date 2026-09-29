import { AllayaError } from '@allaya/shared';
import { resolveApp } from '@allaya/computer';
import type { AppsService } from '../../services/apps-service';
import type { HandlerRegistry } from '../registry';

/** A name that is not in the catalog is refused here, before it can reach anything. */
const known = (name: string): string => {
  if (!resolveApp(name)) {
    throw new AllayaError('That is not an app Allaya knows', { code: 'NOT_FOUND' });
  }
  return name;
};

export function registerAppsHandlers(registry: HandlerRegistry, apps: AppsService): void {
  registry
    .register('apps:list', () => apps.list())
    .register('apps:open', ({ name }) => apps.open(known(name)))
    .register('apps:close', ({ name }) => apps.close(known(name)))
    .register('apps:focus', ({ name }) => apps.focus(known(name)));
}
