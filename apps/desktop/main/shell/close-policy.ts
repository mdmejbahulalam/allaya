export type CloseDecision = 'hide' | 'close';

/**
 * What closing the window does. With "keep running in the tray" on and a tray to keep it in, the window is hidden and
 * Allaya carries on (so schedules and background tasks are not lost); otherwise it closes and, being the last window,
 * quits. A real quit (tray menu, installer restart, the system shutting down) is never held back.
 */
export function decideClose(input: {
  quitting: boolean;
  keepInTray: boolean;
  trayAvailable: boolean;
}): CloseDecision {
  if (input.quitting) return 'close';
  return input.keepInTray && input.trayAvailable ? 'hide' : 'close';
}

/** Started by the operating system at sign-in (`--hidden`): stay in the tray instead of putting a window up. */
export function shouldStartHidden(argv: readonly string[], trayAvailable: boolean): boolean {
  return trayAvailable && argv.includes('--hidden');
}
