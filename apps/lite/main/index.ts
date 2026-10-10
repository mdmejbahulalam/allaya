import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, shell as electronShell } from 'electron';
import type { Logger } from '@allaya/shared';
import { BrowserService } from './browser/service';
import { ElectronBrowserHost } from './browser/electron-host';
import { createBrowserTools } from './browser/tools';
import { ApprovalService, approverForChat } from './core/approvals';
import { ChatService } from './core/chat';
import { ConnectionService } from './core/connections';
import { openDb } from './core/db';
import { Events } from './core/events';
import { SecretStore } from './core/secrets';
import { SettingsStore } from './core/settings';
import { TaskService } from './core/tasks';
import { createTaskTools } from './core/task-tools';
import { Shell } from './shell';
import { shouldQuitWhenAllClosed } from './shell-rules';
import { ToolRegistry } from './core/tools';
import { VoiceService } from './core/voice';
import { createHandlers } from './ipc/handlers';
import { Dispatcher } from './ipc/dispatcher';
import { McpService } from './mcp/service';
import { createLogger } from './logging';
import { APP_INDEX_URL, installAppProtocol, registerAppScheme } from './security/app-protocol';
import { InsecureTestCipher, SafeStorageCipher } from './security/cipher';
import { E2E, e2eBaseUrls } from './security/e2e';
import { applySecurity, isTrustedUrl, senderFromEvent } from './security/window-security';

const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

// The screen is served from our own address; this has to be said before the app is ready.
registerAppScheme();

// Its own folder, so it never touches the data of the earlier Allaya.
const override = process.env['ALLAYA_USER_DATA_DIR'];
if (E2E && override) app.setPath('userData', override);
// Started with --user-data-dir (a check of the packaged program does this) it keeps to that folder, not the real one.
else if (!app.commandLine.hasSwitch('user-data-dir'))
  app.setPath('userData', join(app.getPath('appData'), 'Allaya Lite'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | undefined;

async function start(): Promise<void> {
  await app.whenReady();
  const userData = app.getPath('userData');
  const { logger, file } = createLogger({
    logsDir: join(userData, 'logs'),
    level: 'INFO',
    console: !app.isPackaged,
  });

  const db = openDb(join(userData, 'allaya.sqlite'));
  const events = new Events();
  const cipher = E2E ? new InsecureTestCipher() : new SafeStorageCipher();
  const settings = new SettingsStore(db, (next) => shell.applyLoginItem(next));
  const secrets = new SecretStore(db, cipher);
  const connections = new ConnectionService({
    db,
    secrets,
    events,
    ...(E2E ? { baseUrlOverrides: e2eBaseUrls() } : {}),
  });
  // The browser pane. Its pages are the web's, not ours: see electron-host.ts for how they are kept apart.
  const browser = new ElectronBrowserHost({
    window: () => mainWindow,
    logger: logger.child('browser'),
    onDownloadRefused: (filename) => events.publish('browser:download-refused', { filename }),
  });
  browser.onChange((state) => events.publish('browser:changed', state));
  const tools = new ToolRegistry();
  for (const tool of createBrowserTools(browser)) tools.register(tool);

  // Tasks, and the questions Allaya asks before it changes anything outside itself.
  const shell = new Shell({
    window: () => mainWindow,
    settings: () => settings.get(),
    logger: logger.child('shell'),
    allowTray: !E2E || process.env['ALLAYA_E2E_TRAY'] === '1',
  });
  const approvals = new ApprovalService(events, {
    onRequest: (view) => shell.notify('Allaya needs your OK', view.summary),
  });
  // Connected apps: their tools join the others. Signing in happens in the person's own browser.
  const mcp = new McpService({
    db,
    secrets,
    events,
    tools,
    logger: logger.child('mcp'),
    host: {
      async openBrowser(url) {
        // A test has no person to click: it follows the sign-in page's answer straight back to the app.
        if (E2E) {
          await fetch(url, { redirect: 'follow' }).catch(() => undefined);
          return;
        }
        await electronShell.openExternal(url);
      },
    },
    ...(E2E && Number(process.env['ALLAYA_E2E_SIGN_IN_TIMEOUT_MS']) > 0
      ? { signInTimeoutMs: Number(process.env['ALLAYA_E2E_SIGN_IN_TIMEOUT_MS']) }
      : {}),
  });
  const tasks = new TaskService({
    db,
    connections,
    settings,
    events,
    tools,
    approvals,
    beforeRun: (groups) => mcp.ensure(groups),
    logger: logger.child('tasks'),
    // Tests make the clock quick, to see a scheduled run happen.
    ...(E2E && Number(process.env['ALLAYA_E2E_TICK_MS']) > 0
      ? { tickMs: Number(process.env['ALLAYA_E2E_TICK_MS']) }
      : {}),
    onFinished: (run) =>
      shell.notify(
        run.status === 'done' ? `Done: ${run.taskTitle}` : `${run.taskTitle} did not finish`,
        run.status === 'done' ? run.result.replace(/\s+/g, ' ') : (run.error?.message ?? ''),
      ),
  });
  for (const tool of createTaskTools(
    tasks,
    () => new Date(),
    () => mcp.groups(),
  ))
    tools.register(tool);
  const chat = new ChatService({
    db,
    connections,
    settings,
    events,
    tools,
    approve: approverForChat(approvals),
    logger: logger.child('chat'),
  });
  chat.recoverInterrupted();

  const voice = new VoiceService({ settings, connections });
  const handlers = createHandlers({
    settings,
    connections,
    chat,
    voice,
    browser: new BrowserService(browser),
    tasks,
    approvals,
    mcp,
    info: {
      version: app.getVersion(),
      platform: process.platform,
      locale: app.getLocale(),
      e2e: E2E,
    },
  });
  handlers.assertComplete();
  const security = { devServerUrl: DEV_SERVER_URL, logger };
  const dispatcher = new Dispatcher({
    handlers,
    isTrusted: (sender) => isTrustedUrl(sender.frameUrl, security),
    logger: logger.child('ipc'),
  });
  ipcMain.handle('allaya:invoke', (event, raw: unknown) =>
    dispatcher.dispatch(raw, senderFromEvent(event)),
  );
  events.addSink({
    send(channel, payload) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('allaya:event', { channel, payload });
      }
    },
  });

  if (!DEV_SERVER_URL) installAppProtocol({ rendererRoot: join(__dirname, '../renderer'), logger });
  Menu.setApplicationMenu(null);
  shell.createTray();
  // Started with Windows (--hidden): go straight to the tray, so tasks run without a window in the way.
  const hidden = process.argv.includes('--hidden') && shell.hasTray;
  mainWindow = createWindow(security, shell, hidden);
  shell.applyLoginItem(settings.get());
  tasks.start();
  mcp.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      mainWindow = createWindow(security, shell, false);
    else shell.showWindow();
  });
  app.on('second-instance', () => shell.showWindow());
  app.on('before-quit', () => {
    shell.quitting = true;
    tasks.stop();
    approvals.denyAll();
    void mcp.dispose();
    browser.dispose();
    // Replies still being written are stopped, keeping what they had.
    for (const item of chat.list()) chat.cancel(item.id);
    void file.flush();
  });
  app.on('window-all-closed', () => {
    // Closing the window only hides it while the app is kept in the tray (see Shell.onWindowClose); with that
    // switched off, or with no tray, closing the last window ends the app.
    if (
      shouldQuitWhenAllClosed({
        platform: process.platform,
        background: settings.get().background,
        hasTray: shell.hasTray,
      })
    )
      app.quit();
  });
}

function createWindow(
  security: { devServerUrl: string | undefined; logger: Logger },
  shell: Shell,
  startHidden: boolean,
) {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#1b1a19',
    title: 'Allaya',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  applySecurity(window, security);
  window.once('ready-to-show', () => {
    if (!startHidden) window.show();
  });
  window.on('close', (event) => shell.onWindowClose(event));
  void window.loadURL(DEV_SERVER_URL ?? APP_INDEX_URL);
  return window;
}

start().catch((error: unknown) => {
  // Nothing useful can be shown before the app exists; leave a trace and quit.
  process.stderr.write(
    `Allaya could not start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  app.exit(1);
});
