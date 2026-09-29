import type { HandlerRegistry } from '../registry';
import type { ComputerService } from '../../services/computer-service';

export function registerComputerHandlers(
  registry: HandlerRegistry,
  computer: ComputerService,
): void {
  registry
    .register('computer:getStatus', () => computer.status())
    .register('computer:selfTest', () => computer.selfTest());
}
