import { app, BrowserWindow, globalShortcut, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createTranslator } from '@allaya/localization';
import { release } from 'node:os';
import type { AppInfo } from '@allaya/validation';
import { join } from 'node:path';
import {
  CompositeAdapter,
  ComputerEngine,
  MemoryAdapter,
  PowerShellRunner,
  WindowsAdapter,
} from '@allaya/computer';
import { createContainer, type Container } from './container';
import { ElectronHost } from './computer/electron-host';
import { FolderScreenshotStore } from './computer/screenshot-store';
import { IpcDispatcher } from './ipc/dispatcher';
import type { EventSink } from './ipc/events';
import { createLogger, readLogTail } from './logging';
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
  e2eComputer,
  e2eSaveFile,
  e2eTray,
  e2eUpdateVersion,
} from './security/e2e-hooks';
import { createProbeTool } from './security/e2e-tools';
import { EmergencyStopShortcut } from './security/emergency-shortcut';
import { GlobalShortcut } from './security/global-shortcut';
import { decideClose, shouldStartHidden } from './shell/close-policy';
import {
  ElectronTray,
  createUpdaterPort,
  electronLoginItem,
  electronNotifier,
  iconPath,
} from './shell/electron-shell';
import { uiLocale } from './shell/locale';
import { syncLoginItem } from './shell/login-item';
import { NotificationController } from './shell/notifications';
import { TrayController } from './shell/tray-controller';
import type { UpdaterPort } from './shell/update-service';
import { SafeStorageCipher } from './security/safe-storage-cipher';
import { resolveAppPaths } from './paths';
import { APP_INDEX_URL, installAppProtocol, registerAppScheme } from './security/app-protocol';
import {
  isTrustedRendererUrl,
  microphoneAllowed,
  senderFromEvent,
} from './security/window-security';
import { createFloatingWindow } from './windows/floating-window';
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
let showAppShortcut: GlobalShortcut | undefined;
let tray: TrayController | undefined;
let floating: BrowserWindow | undefined;
/** True once a real quit has begun (tray menu, installer restart, system shutdown): closing then really closes. */
let quitting = false;
let toldAboutTray = false;

/** In a test run, an update feed that always offers the version the test names; installed builds use the real one. */
function updaterPort(): UpdaterPort | undefined {
  if (E2E) {
    const version = e2eUpdateVersion();
    if (!version) return undefined;
    return {
      check: () => Promise.resolve({ version }),
      download: async (onProgress) => {
        onProgress(40);
        await new Promise((resolve) => setTimeout(resolve, 50));
        onProgress(100);
      },
      install: () => {
        quitting = true;
        app.quit();
      },
    };
  }
  return app.isPackaged
    ? createUpdaterPort(logger.child('updates'), () => {
        quitting = true;
      })
    : undefined;
}

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
          E2E && e2eComputer() === 'memory'
            ? new MemoryAdapter({
                installed: ['Chrome', 'Notepad', 'PowerShell'],
                windows: [
                  {
                    id: '11',
                    title: 'Chrome',
                    processName: 'chrome',
                    pid: 4242,
                    bounds: { x: 0, y: 0, width: 800, height: 600 },
                    focused: false,
                    minimized: false,
                  },
                ],
              })
            : process.platform === 'win32'
              ? new WindowsAdapter(new PowerShellRunner())
              : undefined,
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
    diagnostics: {
      logsFolder: paths.logs,
      home: app.getPath('home'),
      readLogTail: async (lines) => {
        await fileLogSink.flush();
        return readLogTail(paths.logs, lines);
      },
      pickSaveFile: E2E ? () => Promise.resolve(e2eSaveFile()) : pickSaveFileDialog,
    },
    showApp: () => showApp(),
    updates: { port: updaterPort() },
    shellStatus: () => ({
      trayAvailable: tray !== undefined,
      launchAtLoginSupported: electronLoginItem.supported,
      showAppKey: showAppShortcut?.status() ?? {
        accelerator: 'Ctrl+Alt+Space',
        registered: false,
        reason: 'unavailable',
      },
    }),
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
      c.stopEverything('shortcut');
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

/** Puts Allaya's window in front (making it if it was closed), optionally on a particular screen. */
function showApp(target?: {
  route: 'home' | 'tasks' | 'activity' | 'settings';
  taskId?: string;
}): void {
  const fresh = !mainWindow || mainWindow.isDestroyed();
  openMainWindow();
  if (!target || !container) return;
  const go = () =>
    container?.events.publish('app:navigate', {
      route: target.route,
      ...(target.taskId ? { taskId: target.taskId } : {}),
    });
  // A window that has only just been made cannot hear the event until its page has loaded.
  if (fresh && mainWindow) mainWindow.webContents.once('did-finish-load', go);
  else go();
}

function openMainWindow(options: { startHidden?: boolean } = {}): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return;
  }
  const window = createMainWindow({
    preloadPath: paths.preload,
    userDataDir: paths.userData,
    security,
    logger,
    backgroundColor: '#0B0D12',
    showImmediately: E2E && !options.startHidden,
    iconPath: iconPath('icon.png'),
    ...(options.startHidden ? { startHidden: true } : {}),
  });
  mainWindow = window;
  // With "keep running in the tray" on, closing the window hides it and Allaya carries on (schedules keep going).
  window.on('close', (event) => {
    const decision = decideClose({
      quitting,
      keepInTray: container?.settings.get('general.minimizeToTray') ?? false,
      trayAvailable: tray !== undefined,
    });
    if (decision !== 'hide') return;
    event.preventDefault();
    window.hide();
    if (!toldAboutTray) {
      toldAboutTray = true;
      electronNotifier.show({
        title: shellTranslator().t('tray.stillRunning'),
        onClick: () => showApp(),
      });
    }
  });
  window.on('closed', () => closeFloating());
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadURL(APP_INDEX_URL);
}

function closeFloating(): void {
  if (floating && !floating.isDestroyed()) floating.destroy();
  floating = undefined;
}

const shellTranslator = () =>
  createTranslator({
    locale: uiLocale(container?.settings.get('language.ui') ?? 'auto', app.getLocale()),
  });

/**
 * The parts of Allaya that live outside its window: the tray, starting at sign-in, desktop notifications and the
 * system-wide "show Allaya" key. Each follows its setting and falls back quietly where the system cannot do it.
 */
function bindShell(c: Container): void {
  // ── the tray ────────────────────────────────────────────────────────────
  const wantTray = E2E ? e2eTray() : process.platform === 'win32' || process.platform === 'darwin';
  if (wantTray) {
    try {
      tray = new TrayController({
        port: new ElectronTray(),
        translator: shellTranslator,
        state: () => ({
          activeRuns: c.runs.active().length,
          automationsPaused: c.settings.get('automations.paused'),
        }),
        actions: {
          open: () => showApp(),
          stop: () => {
            c.stopEverything('tray');
          },
          setAutomationsPaused: (paused) => c.automations.setPaused(paused),
          quit: () => app.quit(),
        },
      });
      const refresh = () => tray?.refresh();
      c.runs.events.on('changed', refresh);
      c.settings.events.on('changed', refresh);
    } catch (error) {
      logger.warn('Could not create the tray icon', { error: String(error) });
      tray = undefined;
    }
  }

  // ── starting at sign-in ─────────────────────────────────────────────────
  const applyLogin = () => {
    try {
      syncLoginItem(electronLoginItem, c.settings.get('general.startWithWindows'));
    } catch (error) {
      logger.warn('Could not change starting at sign-in', { error: String(error) });
    }
    c.events.publish('desktop:changed', {});
  };
  applyLogin();
  let login = c.settings.get('general.startWithWindows');

  // ── notifications ───────────────────────────────────────────────────────
  const notifications = new NotificationController({
    notifier: electronNotifier,
    enabled: () => c.settings.get('notifications.native'),
    windowInFront: () =>
      mainWindow !== undefined &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      mainWindow.isFocused() &&
      !mainWindow.isMinimized(),
    translator: shellTranslator,
    open: (target) => showApp(target),
  });
  c.tasks.subscribe((task) =>
    notifications.taskChanged({
      id: task.id,
      title: task.title,
      state: task.state,
      outcome: task.outcome,
    }),
  );
  c.events.addSink({
    send(channel) {
      if (channel === 'tools:confirmationRequested') notifications.confirmationRequested();
    },
  });

  // ── the floating assistant ──────────────────────────────────────────────
  const applyFloating = () => {
    const wanted = c.settings.get('general.showFloatingAssistant');
    if (!wanted) return closeFloating();
    if (floating && !floating.isDestroyed()) return;
    const base = devServerUrl ?? APP_INDEX_URL;
    floating = createFloatingWindow({
      preloadPath: paths.preload,
      security,
      logger,
      url: `${base}#/floating`,
      backgroundColor: '#0B0D12',
      iconPath: iconPath('icon.png'),
      showImmediately: E2E,
    });
    floating.on('closed', () => {
      floating = undefined;
    });
  };
  applyFloating();
  let floatingWanted = c.settings.get('general.showFloatingAssistant');

  // ── the system-wide "show Allaya" key ───────────────────────────────────
  const show = new GlobalShortcut({
    registrar: globalShortcut,
    accelerator: () => c.settings.get('shortcuts.showApp'),
    onPress: () => showApp(),
    logger: logger.child('show-key'),
    name: 'show-app',
  });
  showAppShortcut = show;
  show.apply();
  let showKey = c.settings.get('shortcuts.showApp');

  c.settings.events.on('changed', (snapshot) => {
    if (snapshot['general.startWithWindows'] !== login) {
      login = snapshot['general.startWithWindows'];
      applyLogin();
    }
    if (snapshot['general.showFloatingAssistant'] !== floatingWanted) {
      floatingWanted = snapshot['general.showFloatingAssistant'];
      applyFloating();
    }
    if (snapshot['shortcuts.showApp'] !== showKey) {
      showKey = snapshot['shortcuts.showApp'];
      show.apply();
      c.events.publish('desktop:changed', {});
    }
  });
}

// Windows groups the taskbar button and attributes notifications by this id; it must match the installer's app id.
if (process.platform === 'win32') app.setAppUserModelId('com.allaya.desktop');

// Must be registered before the app is ready.
registerAppScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showApp());

  void app.whenReady().then(() => {
    logger.info('Allaya starting', { version: app.getVersion(), environment });
    installAppProtocol({ rendererRoot: paths.rendererRoot, logger: logger.child('protocol') });
    container = bootstrapBackend();
    bindTheme(container.settings, () => BrowserWindow.getAllWindows());
    bindEmergencyStop(container);
    bindShell(container);
    if (!E2E) container.updates.start();

    openMainWindow({ startHidden: shouldStartHidden(process.argv, tray !== undefined) });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showApp();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    emergencyShortcut?.release();
    showAppShortcut?.release();
    closeFloating();
    tray?.dispose();
    container?.dispose();
    void fileLogSink.flush();
  });
}
