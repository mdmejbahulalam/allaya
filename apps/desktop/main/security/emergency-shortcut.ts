import type { Logger } from '@allaya/shared';
import type { EmergencyStopStatus } from '@allaya/validation';

/** What the operating system's shortcut registry must offer (Electron's `globalShortcut` fits). */
export interface ShortcutRegistrar {
  /** Returns false when the combination could not be taken (another program holds it). Throws if it is not valid. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

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
 * a person most needs it. The operating system can refuse the key (another program owns it) or the combination can be
 * invalid; that is never silent: the status says so, the Permissions screen shows it, and the STOP button and the
 * in-window key keep working regardless.
 */
export class EmergencyStopShortcut {
  private current: EmergencyStopStatus;
  private held: string | undefined;

  constructor(private readonly deps: EmergencyShortcutDeps) {
    this.current = { accelerator: deps.accelerator(), registered: false, reason: 'unavailable' };
  }

  status(): EmergencyStopStatus {
    return { ...this.current };
  }

  /** (Re)registers the chosen combination, releasing the previous one first. Safe to call whenever the setting changes. */
  apply(): EmergencyStopStatus {
    this.release();
    const accelerator = this.deps.accelerator();
    try {
      const taken = this.deps.registrar.register(accelerator, () => {
        try {
          this.deps.onStop();
        } catch (error) {
          this.deps.logger.error('The emergency stop failed', { error: String(error) });
        }
      });
      if (taken) {
        this.held = accelerator;
        this.current = { accelerator, registered: true };
      } else {
        this.deps.logger.warn('The emergency-stop key could not be registered', { accelerator });
        this.current = { accelerator, registered: false, reason: 'in_use' };
      }
    } catch (error) {
      this.deps.logger.warn('The emergency-stop key is not a valid combination', {
        accelerator,
        error: String(error),
      });
      this.current = { accelerator, registered: false, reason: 'invalid' };
    }
    return this.status();
  }

  /** Gives the key back (on quit). */
  release(): void {
    if (this.held === undefined) return;
    try {
      this.deps.registrar.unregister(this.held);
    } catch {
      /* already gone */
    }
    this.held = undefined;
    this.current = { ...this.current, registered: false, reason: 'unavailable' };
  }
}
