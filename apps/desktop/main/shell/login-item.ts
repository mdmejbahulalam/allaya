export interface LoginItemPort {
  /** False on systems (or builds) where starting at sign-in is not offered — a development run must not register itself. */
  readonly supported: boolean;
  isEnabled(): boolean;
  set(enabled: boolean): void;
}

export type LoginItemResult = 'unsupported' | 'unchanged' | 'changed';

/** Makes the system's "start at sign-in" match the person's setting, touching it only when it differs. */
export function syncLoginItem(port: LoginItemPort, wanted: boolean): LoginItemResult {
  if (!port.supported) return 'unsupported';
  if (port.isEnabled() === wanted) return 'unchanged';
  port.set(wanted);
  return 'changed';
}
