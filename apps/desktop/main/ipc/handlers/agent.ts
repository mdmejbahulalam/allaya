import type { RunRegistry } from '@allaya/shared';
import type { EmergencyStopStatus } from '@allaya/validation';
import type { HandlerRegistry } from '../registry';

export function registerAgentHandlers(
  registry: HandlerRegistry,
  runs: RunRegistry,
  safety: { emergencyStop: () => EmergencyStopStatus },
): void {
  registry
    .register('agent:stop', () => ({ cancelled: runs.cancelAll('emergency stop') }))
    .register('agent:getStatus', () => {
      const activeRuns = runs.active().length;
      return { status: activeRuns > 0 ? ('working' as const) : ('ready' as const), activeRuns };
    })
    .register('agent:getSafety', () => ({ emergencyStop: safety.emergencyStop() }));
}
