import { app, BrowserWindow, globalShortcut, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { release } from 'node:os';
import type { AppInfo } from '@allaya/validation';
import { join } from 'node:path';
import {
  CompositeAdapter,
  ComputerEngine,
  PowerShellRunner,
  WindowsAdapter,
} from '@allaya/computer';
import { createContainer, type Container } from './container';
import { ElectronHost } from './computer/electron-host';
import { FolderScreenshotStore } from './computer/screenshot-store';
import { IpcDispatcher } from './ipc/dispatcher';
import type { EventSink } from './ipc/events';
import { createLogger } from './logging';
import { appendFileSync } from 'node:fs';
import { AppTrash, type KnownFolderId } from '@allaya/filesystem';
import {
  openWithDefaultProgram,
  pickFolderDialog,
  pickSaveFileDialog,
  RecycleBin,
  revealInFileManager,
} from './files/electron-files';
import {
  E2E,
  InsecureTestCipher,
  e2eBaseUrls,
  e2eBrowserExecutable,
  e2eBrowserHosts,
  e2eFilesDir,
  e2ePickedFolder,
  e2eSaveFile,
} from './security/e2e-hooks';
import { createProbeTool } from './security/e2e-tools';
import { EmergencyStopShortcut } from './security/emergency-shortcut';
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
let emergencyShortcut: EmergencyStopShortcut | undefined;

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

/** The folders Allaya may use by default. Tests point them at a sandbox; otherwise they are the user's own. */
function knownFolders(): Partial<Record<KnownFolderId, string>> {
  // A test build never reaches the real profile: without a sandbox it gets folders that do not exist.
  const sandbox = E2E
    ? (e2eFilesDir() ?? join(app.getPath('temp'), 'allaya-e2e-no-files'))
    : undefined;
  if (sandbox) {
    return {
      desktop: join(sandbox, 'Desktop'),
      documents: join(sandbox, 'Documents'),
      downloads: join(sandbox, 'Downloads'),
      pictures: join(sandbox, 'Pictures'),
      videos: join(sandbox, 'Videos'),
      music: join(sandbox, 'Music'),
    };
  }
  return {
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    pictures: app.getPath('pictures'),
    videos: app.getPath('videos'),
    music: app.getPath('music'),
  };
}

function fileAccess() {
  return {
    knownFolders: knownFolders(),
    // Allaya's own database, vault ciphertext, logs and backups are never reachable through the file tools.
    protectedPaths: [paths.userData],
    home: app.getPath('home'),
    backupsFolder: join(paths.userData, 'file-backups'),
    // The Windows Recycle Bin in production. Test runs have no desktop trash, so they use a folder Allaya can restore from.
    trash: E2E ? new AppTrash(join(paths.userData, 'trash')) : new RecycleBin(),
    // Test runs must not launch real programs: they record what would have been opened.
    opener: E2E
      ? (path: string) => {
          appendFileSync(join(paths.userData, 'e2e-opened.txt'), `${path}\n`);
          return Promise.resolve();
        }
      : openWithDefaultProgram,
    pickFolder: E2E ? () => Promise.resolve(e2ePickedFolder()) : pickFolderDialog,
    reveal: E2E ? () => undefined : revealInFileManager,
  };
}

function browserAccess() {
  const profileDir = join(paths.userData, 'browser-profile');
  if (!E2E) return { profileDir };
  // Test runs: drive the Chromium they provide, hidden, and let only the named fixture hosts reach this machine.
  const exe = e2eBrowserExecutable();
  const hosts = e2eBrowserHosts();
  return {
    profileDir,
    noSandbox: true,
    forceHeadless: true,
    ...(exe
      ? { discover: () => ({ kind: 'chromium' as const, path: exe }) }
      : { discover: () => undefined }),
    policyOptions: {
      allowHosts: () => hosts,
      resolve: (host: string) =>
        hosts.includes(host)
          ? Promise.resolve(['127.0.0.1'])
          : Promise.reject(new Error('ENOTFOUND')),
    },
  };
}

function bootstrapBackend(): Container {
  const c = createContainer({
    databasePath: paths.database,
    migrationsFolder: paths.migrations,
    logger: logger.child('core'),
    getAppInfo,
    strict: environment !== 'production',
    computer: {
      // Screenshots, clipboard and displays come from Electron everywhere; window/mouse/keyboard control is
      // implemented for Windows only (everywhere else the engine reports those features as unavailable).
      engine: new ComputerEngine({
        adapter: new CompositeAdapter(
          process.platform === 'win32' ? new WindowsAdapter(new PowerShellRunner()) : undefined,
          new ElectronHost(),
        ),
        ownPid: process.pid,
      }),
      screenshots: new FolderScreenshotStore(
        E2E ? join(paths.userData, 'screenshots') : join(app.getPath('pictures'), 'Allaya'),
      ),
    },
    files: fileAccess(),
    browser: browserAccess(),
    emergencyStop: () =>
      emergencyShortcut?.status() ?? {
        accelerator: 'Ctrl+Shift+Escape',
        registered: false,
        reason: 'unavailable',
      },
    memory: {
      pickSaveFile: E2E ? () => Promise.resolve(e2eSaveFile()) : pickSaveFileDialog,
    },
    cipher: E2E ? new InsecureTestCipher() : new SafeStorageCipher(),
    ...(E2E
      ? {
          providerOptions: { baseUrls: e2eBaseUrls(), maxRetries: 0, backoffMs: 0 },
          extraTools: [createProbeTool()],
        }
      : {}),
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

/**
 * The system-wide emergency-stop key: it stops everything exactly as the STOP button does, even when the window is
 * hidden or unfocused. It follows the "Emergency stop" shortcut setting and is given back on quit.
 */
function bindEmergencyStop(c: Container): void {
  const shortcut = new EmergencyStopShortcut({
    registrar: globalShortcut,
    accelerator: () => c.settings.get('shortcuts.emergencyStop'),
    onStop: () => {
      const cancelled = c.runs.cancelAll('emergency stop');
      c.events.publish('agent:stopped', { cancelled, via: 'shortcut' });
    },
    logger: logger.child('emergency-stop'),
  });
  emergencyShortcut = shortcut;
  shortcut.apply();
  let last = c.settings.get('shortcuts.emergencyStop');
  c.settings.events.on('changed', (snapshot) => {
    if (snapshot['shortcuts.emergencyStop'] === last) return;
    last = snapshot['shortcuts.emergencyStop'];
    shortcut.apply();
    c.events.publish('agent:safetyChanged', {});
  });
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
    bindEmergencyStop(container);

    openMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    emergencyShortcut?.release();
    container?.dispose();
    void fileLogSink.flush();
  });
}
