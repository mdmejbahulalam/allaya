import { BrowserWindow, screen } from 'electron';
import type { Logger } from '@allaya/shared';
import { applySecurity, type SecurityConfig } from '../security/window-security';

export interface FloatingWindowOptions {
  preloadPath: string;
  security: SecurityConfig;
  logger: Logger;
  /** Where its page is (the same app, `#/floating`). */
  url: string;
  backgroundColor: string;
  iconPath?: string;
  /** Show at once (tests) instead of waiting for first paint. */
  showImmediately?: boolean;
}

export const FLOATING_SIZE = { width: 320, height: 56 } as const;
const MARGIN = 16;

/**
 * The floating assistant: a small always-on-top bar with what Allaya is doing, STOP, and a way back to the app. It has
 * no frame and no taskbar button, and it is exactly as locked down as the main window (same sandbox, same origin, same
 * policies); it is only a different page of the same app.
 */
export function createFloatingWindow(options: FloatingWindowOptions): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    ...FLOATING_SIZE,
    x: area.x + area.width - FLOATING_SIZE.width - MARGIN,
    y: area.y + MARGIN,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Allaya',
    backgroundColor: options.backgroundColor,
    ...(options.iconPath ? { icon: options.iconPath } : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      safeDialogs: true,
    },
  });
  window.setAlwaysOnTop(true, 'floating');
  applySecurity(window, options.security);
  window.once('ready-to-show', () => window.showInactive());
  if (options.showImmediately) window.showInactive();
  window.webContents.on('render-process-gone', (_event, details) => {
    options.logger.error('Floating assistant process gone', { reason: details.reason });
  });
  void window.loadURL(options.url);
  return window;
}
