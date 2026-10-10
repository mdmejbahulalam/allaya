import { join } from 'node:path';
import { Menu, Notification, Tray, app, nativeImage, type BrowserWindow } from 'electron';
import type { Logger } from '@allaya/shared';
import type { Settings } from '../shared/ipc';
import { shouldHideOnClose, shouldNotify } from './shell-rules';

export interface ShellOptions {
  window: () => BrowserWindow | undefined;
  settings: () => Settings;
  logger: Logger;
  /** A bare Linux display has no tray; a test turns it on deliberately. */
  allowTray: boolean;
}

/**
 * The parts of the app that live outside its window: the tray icon, desktop notices, and starting with Windows. The
 * app keeps running in the tray after its window is closed, so scheduled tasks can run; the tray menu quits it.
 */
export class Shell {
  private tray: Tray | undefined;
  quitting = false;
  private toldAboutTray = false;

  constructor(private readonly options: ShellOptions) {}

  get hasTray(): boolean {
    return this.tray !== undefined;
  }

  showWindow(): void {
    const window = this.options.window();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private iconPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'icons', 'tray.png')
      : join(__dirname, '../../build/tray.png');
  }

  createTray(): void {
    if (this.tray || !this.options.allowTray) return;
    try {
      const icon = nativeImage.createFromPath(this.iconPath());
      this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
      this.tray.setToolTip('Allaya');
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Open Allaya', click: () => this.showWindow() },
          { type: 'separator' },
          {
            label: 'Quit',
            click: () => {
              this.quitting = true;
              app.quit();
            },
          },
        ]),
      );
      this.tray.on('click', () => this.showWindow());
    } catch (error) {
      this.options.logger.warn('Could not create the tray icon', {
        error: String(error).slice(0, 120),
      });
      this.tray = undefined;
    }
  }

  /** Called when the window is closed: hide it to the tray, once telling the person where the app went. */
  onWindowClose(event: { preventDefault: () => void }): void {
    const settings = this.options.settings();
    if (
      !shouldHideOnClose({
        background: settings.background,
        hasTray: this.hasTray,
        quitting: this.quitting,
      })
    )
      return;
    event.preventDefault();
    this.options.window()?.hide();
    if (!this.toldAboutTray) {
      this.toldAboutTray = true;
      this.notify(
        'Allaya is still running',
        'It keeps running in the tray so your tasks can run. Quit it from the tray icon.',
        true,
      );
    }
  }

  notify(title: string, body: string, always = false): void {
    const window = this.options.window();
    const focused = !!window && !window.isDestroyed() && window.isVisible() && window.isFocused();
    if (!always && !shouldNotify(this.options.settings(), focused)) return;
    if (!Notification.isSupported()) return;
    const notice = new Notification({ title, body: body.slice(0, 200) });
    notice.on('click', () => this.showWindow());
    notice.show();
  }

  /** Start with Windows (in the tray), as set. */
  applyLoginItem(settings: Settings): void {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    try {
      app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, args: ['--hidden'] });
    } catch (error) {
      this.options.logger.warn('Could not change starting with Windows', {
        error: String(error).slice(0, 120),
      });
    }
  }
}
