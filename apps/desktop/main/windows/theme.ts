import { nativeTheme, type BrowserWindow } from 'electron';
import type { SettingsService } from '../services/settings-service';

type ThemeSetting = 'dark' | 'light' | 'system';

/** Colours for the native Windows caption buttons that overlay our header (header uses `bg-2`). */
export function titleBarColors(theme: 'dark' | 'light'): { color: string; symbolColor: string } {
  return theme === 'dark'
    ? { color: '#11141B', symbolColor: '#9AA3B2' }
    : { color: '#FFFFFF', symbolColor: '#576072' };
}

/**
 * Keeps Electron's notion of the theme in step with the user's setting, so `prefers-color-scheme`
 * in the renderer, native dialogs, and the caption-button overlay all agree with the app.
 */
export function bindTheme(settings: SettingsService, getWindows: () => BrowserWindow[]): void {
  const apply = (theme: ThemeSetting) => {
    nativeTheme.themeSource = theme;
    const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    for (const window of getWindows()) {
      if (window.isDestroyed()) continue;
      try {
        // Only meaningful on Windows/Linux frames with an overlay; a no-op elsewhere.
        window.setTitleBarOverlay({ ...titleBarColors(resolved), height: 48 });
      } catch {
        /* platform without overlay support */
      }
    }
  };
  apply(settings.get('appearance.theme'));
  settings.events.on('changed', (snapshot) => apply(snapshot['appearance.theme']));
  nativeTheme.on('updated', () => {
    if (settings.get('appearance.theme') === 'system') apply('system');
  });
}
