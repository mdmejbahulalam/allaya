import { APP_CATALOG } from './apps';
import { AllayaError } from '@allaya/shared';
import type {
  ComputerAdapter,
  ComputerCapabilities,
  DisplayInfo,
  ElementQuery,
  KeyChord,
  LaunchRequest,
  MouseButton,
  ScreenshotResult,
  WindowInfo,
} from './types';

/** A 1×1 transparent PNG. */
export const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

export interface MemoryAdapterOptions {
  capabilities?: Partial<ComputerCapabilities>;
  windows?: WindowInfo[];
  displays?: DisplayInfo[];
  /** Launching an app creates its window (default). Set `false` to simulate an app that never shows up. */
  windowsAppearOnLaunch?: boolean;
  /** Closing removes the window (default). `false` simulates an app that refuses to close (e.g. "save changes?"). */
  windowsCloseOnRequest?: boolean;
  /** Names of controls that exist, for `invokeElement`. */
  elements?: string[];
}

/**
 * A deterministic, in-memory desktop for tests and for running Allaya on machines with no input adapter. It
 * records everything done to it, so tests can prove exactly what would have reached a real computer.
 */
export class MemoryAdapter implements ComputerAdapter {
  readonly platform: NodeJS.Platform = 'win32';
  readonly name = 'memory';
  windows: WindowInfo[];
  clipboard = '';
  readonly launched: string[] = [];
  readonly closed: string[] = [];
  readonly focusedIds: string[] = [];
  readonly typed: string[] = [];
  readonly chords: KeyChord[] = [];
  readonly clicks: Array<{ x: number; y: number; button: MouseButton; count: number }> = [];
  readonly scrolls: number[] = [];
  readonly invoked: ElementQuery[] = [];
  private nextId = 100;
  private readonly caps: ComputerCapabilities;
  private readonly screens: DisplayInfo[];

  constructor(private readonly options: MemoryAdapterOptions = {}) {
    this.caps = {
      windows: true,
      launch: true,
      screenshot: true,
      clipboard: true,
      mouse: true,
      keyboard: true,
      uiAutomation: true,
      ...options.capabilities,
    };
    this.windows = options.windows ? options.windows.map((w) => ({ ...w })) : [];
    this.screens = options.displays ?? [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: true },
    ];
  }

  capabilities(): ComputerCapabilities {
    return this.caps;
  }

  addWindow(partial: Partial<WindowInfo> & Pick<WindowInfo, 'processName'>): WindowInfo {
    const window: WindowInfo = {
      id: String(this.nextId++),
      title: partial.processName,
      pid: 1000 + this.nextId,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      focused: false,
      minimized: false,
      ...partial,
    };
    this.windows.push(window);
    return window;
  }

  async listWindows(): Promise<WindowInfo[]> {
    return this.windows.map((w) => ({ ...w, bounds: { ...w.bounds } }));
  }

  async focusWindow(id: string): Promise<void> {
    const target = this.windows.find((w) => w.id === id);
    if (!target) throw new AllayaError('No such window', { code: 'NOT_FOUND' });
    this.focusedIds.push(id);
    for (const w of this.windows) w.focused = w.id === id;
    target.minimized = false;
  }

  async closeWindow(id: string): Promise<void> {
    this.closed.push(id);
    if (this.options.windowsCloseOnRequest === false) return;
    this.windows = this.windows.filter((w) => w.id !== id);
  }

  async launch(request: LaunchRequest): Promise<{ pid?: number }> {
    this.launched.push(request.executable);
    const entry = APP_CATALOG.find((a) => a.windows === request.executable);
    if (this.options.windowsAppearOnLaunch !== false && entry) {
      const window = this.addWindow({ processName: entry.processes[0]!, title: entry.name });
      for (const w of this.windows) w.focused = w.id === window.id;
      return { pid: window.pid };
    }
    return {};
  }

  async displays(): Promise<DisplayInfo[]> {
    return this.screens;
  }

  async screenshot(): Promise<ScreenshotResult> {
    return { bytes: TINY_PNG, mimeType: 'image/png', width: 1, height: 1 };
  }

  async getClipboardText(): Promise<string> {
    return this.clipboard;
  }
  async setClipboardText(text: string): Promise<void> {
    this.clipboard = text;
  }

  async moveMouse(): Promise<void> {
    /* position is not modelled */
  }
  async clickMouse(x: number, y: number, button: MouseButton, count: 1 | 2): Promise<void> {
    this.clicks.push({ x, y, button, count });
  }
  async scroll(deltaY: number): Promise<void> {
    this.scrolls.push(deltaY);
  }
  async typeText(text: string): Promise<void> {
    this.typed.push(text);
  }
  async pressKeys(chord: KeyChord): Promise<void> {
    this.chords.push(chord);
  }
  async invokeElement(query: ElementQuery): Promise<boolean> {
    this.invoked.push(query);
    return (this.options.elements ?? []).some(
      (name) => name.toLowerCase() === query.name.toLowerCase(),
    );
  }
}
