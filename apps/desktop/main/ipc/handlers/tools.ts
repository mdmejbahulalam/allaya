import type { HandlerRegistry } from '../registry';
import type { PermissionService } from '../../services/permission-service';
import type { ToolService } from '../../services/tool-service';

export function registerToolHandlers(
  registry: HandlerRegistry,
  tools: ToolService,
  permissions: PermissionService,
): void {
  registry
    .register('tools:listPendingConfirmations', () => tools.pendingConfirmations())
    // This channel is only reachable from the trusted window, so an answer here is an on-screen answer.
    .register('tools:respondConfirmation', ({ id, decision }) => ({
      accepted: tools.respond(id, decision, 'ui').ok,
    }))
    .register('permissions:list', () => permissions.list())
    .register('permissions:set', ({ subject, mode }) => permissions.set(subject, mode));
}
