import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import type { Logger } from '@allaya/shared';
import { ChatService } from './core/chat';
import { ConnectionService } from './core/connections';
import { openDb } from './core/db';
import { Events } from './core/events';
import { SecretStore } from './core/secrets';
import { SettingsStore } from './core/settings';
import { VoiceService } from './core/voice';
import { createHandlers } from './ipc/handlers';
import { Dispatcher } from './ipc/dispatcher';
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
else app.setPath('userData', join(app.getPath('appData'), 'Allaya Lite'));

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
  const settings = new SettingsStore(db);
  const secrets = new SecretStore(db, cipher);
  const connections = new ConnectionService({
    db,
    secrets,
    events,
    ...(E2E ? { baseUrlOverrides: e2eBaseUrls() } : {}),
  });
  const chat = new ChatService({
    db,
    connections,
    settings,
    events,
    logger: logger.child('chat'),
  });
  chat.recoverInterrupted();

  const voice = new VoiceService({ settings, connections });
  const handlers = createHandlers({
    settings,
    connections,
    chat,
    voice,
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
  mainWindow = createWindow(security);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(security);
  });
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on('before-quit', () => {
    // Replies still being written are stopped, keeping what they had.
    for (const item of chat.list()) chat.cancel(item.id);
    void file.flush();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function createWindow(security: { devServerUrl: string | undefined; logger: Logger }) {
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
  window.once('ready-to-show', () => window.show());
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
