import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { release } from 'node:os';
import type { AppInfo } from '@allaya/validation';
import { createContainer, type Container } from './container';
import { IpcDispatcher } from './ipc/dispatcher';
import type { EventSink } from './ipc/events';
import { createLogger } from './logging';
import { E2E, InsecureTestCipher, e2eBaseUrls } from './security/e2e-hooks';
import { SafeStorageCipher } from './security/safe-storage-cipher';
import { resolveAppPaths } from './paths';
import { APP_INDEX_URL, installAppProtocol, registerAppScheme } from './security/app-protocol';
import {
  isTrustedRendererUrl,
  microphoneAllowed,
  senderFromEvent,
} from './security/window-security';
import { createMainWindow } from './windows/main-window';
import { bindTheme } from './windows/theme';

const INVOKE_CHANNEL = 'allaya:invoke';
const EVENT_CHANNEL = 'allaya:event';

const modeEnv = import.meta.env.MODE;
const environment: AppInfo['environment'] =
  modeEnv === 'staging'
    ? 'staging'
    : app.isPackaged || modeEnv === 'production'
      ? 'production'
      : 'development';
const isDev = environment === 'development';

const paths = resolveAppPaths();
const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
const { logger, file: fileLogSink } = createLogger({
  logsDir: paths.logs,
  level: isDev ? 'DEBUG' : 'INFO',
  console: isDev,
});

let container: Container | undefined;
let mainWindow: BrowserWindow | undefined;

const security = {
  ...(devServerUrl ? { devServerUrl } : {}),
  logger: logger.child('security'),
};

function getAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    osVersion: release(),
    arch: process.arch,
    osLocale: app.getLocale(),
    isPackaged: app.isPackaged,
    environment,
  };
}

function bootstrapBackend(): Container {
  const c = createContainer({
    databasePath: paths.database,
    migrationsFolder: paths.migrations,
    logger: logger.child('core'),
    getAppInfo,
    strict: environment !== 'production',
    cipher: E2E ? new InsecureTestCipher() : new SafeStorageCipher(),
    ...(E2E ? { providerOptions: { baseUrls: e2eBaseUrls(), maxRetries: 0, backoffMs: 0 } } : {}),
  });
  c.registry.assertComplete();

  // The microphone permission follows the user's consent setting, and nothing else.
  microphoneAllowed.value = c.settings.get('voice.enabled');
  c.settings.events.on('changed', (snapshot) => {
    microphoneAllowed.value = snapshot['voice.enabled'];
  });

  const dispatcher = new IpcDispatcher({
    registry: c.registry,
    logger: logger.child('ipc'),
    validateResponses: environment !== 'production',
    isTrustedSender: (sender) => isTrustedRendererUrl(sender.frameUrl, security),
  });

  ipcMain.handle(INVOKE_CHANNEL, (event: IpcMainInvokeEvent, raw: unknown) =>
    dispatcher.dispatch(raw, senderFromEvent(event)),
  );

  // Fan events out to every live renderer window.
  const sink: EventSink = {
    send(channel, payload) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, { channel, payload });
      }
    },
  };
  c.events.addSink(sink);
  return c;
}

function openMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  mainWindow = createMainWindow({
    preloadPath: paths.preload,
    userDataDir: paths.userData,
    security,
    logger,
    backgroundColor: '#0B0D12',
    showImmediately: E2E,
  });
  if (devServerUrl) void mainWindow.loadURL(devServerUrl);
  else void mainWindow.loadURL(APP_INDEX_URL);
}

// Must be registered before the app is ready.
registerAppScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => openMainWindow());

  void app.whenReady().then(() => {
    logger.info('Allaya starting', { version: app.getVersion(), environment });
    installAppProtocol({ rendererRoot: paths.rendererRoot, logger: logger.child('protocol') });
    container = bootstrapBackend();
    bindTheme(container.settings, () => BrowserWindow.getAllWindows());

    openMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    container?.dispose();
    void fileLogSink.flush();
  });
}
