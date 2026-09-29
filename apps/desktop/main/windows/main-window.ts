import { BrowserWindow } from 'electron';
import type { Logger } from '@allaya/shared';
import { applySecurity, type SecurityConfig } from '../security/window-security';
import { titleBarColors } from './theme';
import { WindowStateStore } from './window-state';

export interface MainWindowOptions {
  preloadPath: string;
  userDataDir: string;
  security: SecurityConfig;
  logger: Logger;
  /** Show immediately (tests) instead of waiting for first paint. */
  showImmediately?: boolean;
  backgroundColor: string;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const stateStore = new WindowStateStore(options.userDataDir);
  const state = stateStore.load();

  const window = new BrowserWindow({
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Allaya',
    backgroundColor: options.backgroundColor,
    // Our own header renders in the title-bar area; native controls overlay it on Windows.
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors('dark'), height: 48 },
    autoHideMenuBar: true,
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

  applySecurity(window, options.security);
  stateStore.track(window);
  if (state.maximized) window.maximize();

  window.once('ready-to-show', () => window.show());
  if (options.showImmediately) window.show();

  window.webContents.on('render-process-gone', (_event, details) => {
    options.logger.error('Renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  return window;
}
