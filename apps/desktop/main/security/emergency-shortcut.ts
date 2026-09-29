import type { Logger } from '@allaya/shared';
import { GlobalShortcut, type ShortcutRegistrar } from './global-shortcut';

export type { ShortcutRegistrar } from './global-shortcut';

export interface EmergencyShortcutDeps {
  registrar: ShortcutRegistrar;
  /** The combination the person chose (a setting). */
  accelerator: () => string;
  /** What to do when the key is pressed: stop everything, exactly as the STOP button does. */
  onStop: () => void;
  logger: Logger;
}

/**
 * The system-wide emergency stop. It works when Allaya's window is hidden, unfocused or minimised — the case where
 * a person most needs it. If the operating system refuses the key, the status says so (the Permissions screen shows
 * it) and the STOP button and the in-window key keep working regardless.
 */
export class EmergencyStopShortcut extends GlobalShortcut {
  constructor(deps: EmergencyShortcutDeps) {
    super({
      registrar: deps.registrar,
      accelerator: deps.accelerator,
      onPress: deps.onStop,
      logger: deps.logger,
      name: 'emergency-stop',
    });
  }
}
