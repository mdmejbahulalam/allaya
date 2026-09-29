import type { HandlerRegistry } from '../registry';
import type { AutomationService } from '../../services/automation-service';

export function registerAutomationHandlers(
  registry: HandlerRegistry,
  automations: AutomationService,
): void {
  registry
    .register('automations:list', () => automations.overview())
    .register('automations:runs', ({ id, limit }) => automations.runs(id, limit))
    .register('automations:create', (input) => automations.create(input))
    .register('automations:update', ({ id, changes }) => automations.update(id, changes))
    .register('automations:setEnabled', ({ id, enabled }) => automations.setEnabled(id, enabled))
    .register('automations:runNow', ({ id }) => automations.runNow(id))
    .register('automations:delete', ({ id }) => {
      automations.remove(id);
      return { ok: true as const };
    })
    .register('automations:setPaused', ({ paused }) => {
      automations.setPaused(paused);
      return { ok: true as const };
    });
}
