import type { DiagnosticsService } from '../../services/diagnostics-service';
import type { HandlerRegistry } from '../registry';

export function registerDiagnosticsHandlers(
  registry: HandlerRegistry,
  diagnostics: DiagnosticsService,
): void {
  registry
    .register('diagnostics:get', () => diagnostics.get())
    .register('diagnostics:export', async () => ({ saved: await diagnostics.export() }));
}
