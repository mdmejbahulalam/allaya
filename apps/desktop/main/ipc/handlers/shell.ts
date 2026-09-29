import type { ShellStatus } from '@allaya/validation';
import type { UpdateService } from '../../shell/update-service';
import type { HandlerRegistry } from '../registry';

export function registerShellHandlers(
  registry: HandlerRegistry,
  updates: UpdateService,
  shellStatus: () => ShellStatus,
  actions: { showApp: () => void; stopEverything: (via: 'floating') => number },
): void {
  registry
    .register('desktop:getStatus', () => shellStatus())
    .register('desktop:showApp', () => {
      actions.showApp();
      return { ok: true as const };
    })
    .register('desktop:stopEverything', () => ({ cancelled: actions.stopEverything('floating') }))
    .register('updates:getStatus', () => updates.status())
    .register('updates:check', () => updates.checkNow())
    .register('updates:download', () => updates.download())
    .register('updates:install', () => {
      updates.install();
      return { ok: true as const };
    });
}
