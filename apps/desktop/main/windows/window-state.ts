import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, type BrowserWindow, type Rectangle } from 'electron';

interface PersistedState extends Rectangle {
  maximized: boolean;
}

const DEFAULT: PersistedState = { x: 0, y: 0, width: 1440, height: 900, maximized: false };

/** Remembers window bounds between launches, clamped to a display that still exists. */
export class WindowStateStore {
  private readonly file: string;
  constructor(userDataDir: string, name = 'window-state') {
    this.file = join(userDataDir, `${name}.json`);
  }

  load(): Partial<PersistedState> & Pick<PersistedState, 'width' | 'height'> {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
      const width = Math.max(960, saved.width ?? DEFAULT.width);
      const height = Math.max(600, saved.height ?? DEFAULT.height);
      if (typeof saved.x === 'number' && typeof saved.y === 'number') {
        const visible = screen.getAllDisplays().some((d) => {
          const b = d.workArea;
          return (
            saved.x! >= b.x - 50 &&
            saved.y! >= b.y - 50 &&
            saved.x! < b.x + b.width &&
            saved.y! < b.y + b.height
          );
        });
        if (visible)
          return { x: saved.x, y: saved.y, width, height, maximized: saved.maximized ?? false };
      }
      return { width, height, maximized: saved.maximized ?? false };
    } catch {
      return { width: DEFAULT.width, height: DEFAULT.height, maximized: false };
    }
  }

  track(window: BrowserWindow): void {
    let timer: NodeJS.Timeout | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (window.isDestroyed()) return;
        const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
        try {
          writeFileSync(this.file, JSON.stringify({ ...bounds, maximized: window.isMaximized() }));
        } catch {
          /* non-fatal */
        }
      }, 400);
    };
    window.on('resize', save);
    window.on('move', save);
    window.on('close', () => {
      clearTimeout(timer);
      save();
    });
  }
}
