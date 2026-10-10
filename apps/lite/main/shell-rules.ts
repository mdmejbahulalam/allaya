import type { Settings } from '../shared/ipc';

/** Closing the window keeps the app running in the tray (so tasks still run) — unless the person is quitting. */
export function shouldHideOnClose(options: {
  background: boolean;
  hasTray: boolean;
  quitting: boolean;
}): boolean {
  return options.background && options.hasTray && !options.quitting;
}

/** A desktop notice is for when the person is not looking at the app. */
export function shouldNotify(
  settings: Pick<Settings, 'notifyTasks'>,
  windowFocused: boolean,
): boolean {
  return settings.notifyTasks && !windowFocused;
}

/**
 * When no window is left: end the app, unless it is meant to stay in the tray. (On a Mac an app conventionally stays
 * until quit.)
 */
export function shouldQuitWhenAllClosed(options: {
  platform: string;
  background: boolean;
  hasTray: boolean;
}): boolean {
  if (options.platform === 'darwin') return false;
  return !(options.background && options.hasTray);
}
