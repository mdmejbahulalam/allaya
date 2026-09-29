import type { Logger } from '@allaya/shared';

/** What the operating system's shortcut registry must offer (Electron's `globalShortcut` fits). */
export interface ShortcutRegistrar {
  /** Returns false when the combination could not be taken (another program holds it). Throws if it is not valid. */
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface GlobalShortcutStatus {
  /** The key combination the person chose (Electron accelerator form, e.g. `Ctrl+Shift+Escape`). */
  accelerator: string;
  registered: boolean;
  /** Why not: another program holds the key, the combination is not valid, or this system cannot do it. */
  reason?: 'in_use' | 'invalid' | 'unavailable';
}

export interface GlobalShortcutDeps {
  registrar: ShortcutRegistrar;
  /** The combination the person chose (a setting). */
  accelerator: () => string;
  /** What to do when the key is pressed. */
  onPress: () => void;
  logger: Logger;
  /** For the log only. */
  name: string;
}

/**
 * One system-wide key. The operating system can refuse it (another program owns it) or the combination can be invalid;
 * that is never silent: the status says so, and the caller shows it.
 */
export class GlobalShortcut {
  private current: GlobalShortcutStatus;
  private held: string | undefined;

  constructor(private readonly deps: GlobalShortcutDeps) {
    this.current = { accelerator: deps.accelerator(), registered: false, reason: 'unavailable' };
  }

  status(): GlobalShortcutStatus {
    return { ...this.current };
  }

  /** (Re)registers the chosen combination, releasing the previous one first. Safe to call whenever the setting changes. */
  apply(): GlobalShortcutStatus {
    this.release();
    const accelerator = this.deps.accelerator();
    try {
      const taken = this.deps.registrar.register(accelerator, () => {
        try {
          this.deps.onPress();
        } catch (error) {
          this.deps.logger.error(`The ${this.deps.name} key failed`, { error: String(error) });
        }
      });
      if (taken) {
        this.held = accelerator;
        this.current = { accelerator, registered: true };
      } else {
        this.deps.logger.warn(`The ${this.deps.name} key could not be registered`, { accelerator });
        this.current = { accelerator, registered: false, reason: 'in_use' };
      }
    } catch (error) {
      this.deps.logger.warn(`The ${this.deps.name} key is not a valid combination`, {
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
