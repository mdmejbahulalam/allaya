import { join } from 'node:path';
import { app, Menu, Notification, nativeImage, Tray } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { Logger } from '@allaya/shared';
import type { LoginItemPort } from './login-item';
import type { NotifierPort } from './notifications';
import type { TrayPort } from './tray-controller';
import type { TrayItem, TrayItemId } from './tray-menu';
import type { UpdaterPort } from './update-service';

/**
 * The thin layer that connects the tested shell logic to Electron. Everything here needs the real desktop, and most of
 * it (a Windows tray, start at sign-in, an installer's updater) can be exercised only on Windows; the decisions that
 * matter are in the neighbouring modules, which are tested without Electron.
 */

/** Where the icon files live: next to the app's resources once installed, in the project's build folder otherwise. */
export function iconPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', name)
    : join(app.getAppPath(), 'build', name);
}

export class ElectronTray implements TrayPort {
  private readonly tray: Tray;
  private click: ((id: TrayItemId) => void) | undefined;

  constructor() {
    // Windows scales a 32-pixel image down for a normal display and up for a high-density one.
    this.tray = new Tray(nativeImage.createFromPath(iconPath('tray.png')));
  }

  setToolTip(text: string): void {
    this.tray.setToolTip(text);
  }

  setMenu(items: TrayItem[], click: (id: TrayItemId) => void): void {
    this.click = click;
    this.tray.setContextMenu(
      Menu.buildFromTemplate(
        items.map((item) =>
          item.type === 'separator'
            ? { type: 'separator' as const }
            : { label: item.label, click: () => this.click?.(item.id) },
        ),
      ),
    );
  }

  onClick(callback: () => void): void {
    this.tray.on('click', callback);
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}

/** "Start with Windows". Only an installed build on Windows or macOS may touch it; a development run must not register itself. */
export const electronLoginItem: LoginItemPort = {
  supported: app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin'),
  isEnabled: () => app.getLoginItemSettings().openAtLogin,
  // `--hidden` makes the sign-in start stay in the tray instead of putting a window up.
  set: (enabled) =>
    app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ['--hidden'] : [] }),
};

export const electronNotifier: NotifierPort = {
  show({ title, body, onClick }) {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title,
      ...(body ? { body } : {}),
      icon: nativeImage.createFromPath(iconPath('icon.png')),
    });
    notification.on('click', onClick);
    notification.show();
  },
};

/**
 * The update feed, through electron-updater (the feed's address is written into the app by the installer build, from the
 * `publish` settings in `electron-builder.yml`). Nothing downloads or installs on its own: the service decides when.
 */
export function createUpdaterPort(logger: Logger, beforeInstall: () => void): UpdaterPort {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (message: unknown) => logger.info(String(message)),
    warn: (message: unknown) => logger.warn(String(message)),
    error: (message: unknown) => logger.error(String(message)),
    debug: (message: unknown) => logger.debug(String(message)),
  };
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : undefined;
    },
    async download(onProgress) {
      const listener = (progress: { percent: number }) => onProgress(progress.percent);
      autoUpdater.on('download-progress', listener);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.off('download-progress', listener);
      }
    },
    install() {
      beforeInstall();
      autoUpdater.quitAndInstall(false, true);
    },
  };
}
