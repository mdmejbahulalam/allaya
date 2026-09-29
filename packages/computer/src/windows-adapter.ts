import { AllayaError } from '@allaya/shared';
import type { ScriptRunner } from './powershell';
import { SCRIPTS } from './windows-scripts';
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

/** Virtual-key codes for the keys Allaya will press (see `keys.ts`). */
const VK: Record<string, number> = {
  enter: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  insert: 0x2d,
};
const MODIFIER_VK = { ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5b } as const;

/** Virtual-key code for a validated key name; `undefined` for anything else. */
export function virtualKey(key: string): number | undefined {
  const k = key.toLowerCase();
  if (VK[k] !== undefined) return VK[k];
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
  const f = /^f(\d{1,2})$/.exec(k);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return 0x70 + Number(f[1]) - 1;
  return undefined;
}

interface RawWindow {
  id: string;
  title: string;
  processName: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  focused: boolean;
  elevated: boolean;
}

/**
 * Windows implementation: window management, launching, mouse, keyboard and UI Automation through PowerShell +
 * Win32. Screenshots, clipboard and display info are supplied by the host (Electron) — see `CompositeAdapter`.
 *
 * Unverified on real Windows in this repository's CI (Linux). Its parsing and argument handling are unit-tested
 * against a fake runner, and its scripts are syntax-checked; behaviour on a real desktop must be confirmed by the
 * self-test (`computer:selfTest`).
 */
export class WindowsAdapter implements ComputerAdapter {
  readonly platform: NodeJS.Platform = 'win32';
  readonly name = 'windows';

  constructor(private readonly runner: ScriptRunner) {}

  capabilities(): ComputerCapabilities {
    return {
      windows: true,
      launch: true,
      screenshot: false,
      clipboard: false,
      mouse: true,
      keyboard: true,
      uiAutomation: true,
    };
  }

  private async json<T>(
    script: keyof typeof SCRIPTS,
    args: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const out = await this.runner.run(
      SCRIPTS[script],
      args,
      timeoutMs === undefined ? {} : { timeoutMs },
    );
    try {
      // A launched console program may print to the same stream first; the helper's answer is the last JSON line.
      const line =
        out
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.trim().startsWith('{'))
          .pop() ?? '';
      return JSON.parse(line) as T;
    } catch (cause) {
      throw new AllayaError('The Windows helper returned something unreadable', {
        code: 'TOOL_EXECUTION_FAILED',
        cause,
      });
    }
  }

  async listWindows(): Promise<WindowInfo[]> {
    const { windows } = await this.json<{ windows: RawWindow[] | RawWindow | null }>(
      'listWindows',
      null,
    );
    // PowerShell collapses one-element arrays in some versions; accept both shapes.
    const list = Array.isArray(windows) ? windows : windows ? [windows] : [];
    return list.map((w) => ({
      id: String(w.id),
      title: String(w.title ?? ''),
      processName: String(w.processName ?? '').toLowerCase(),
      pid: Number(w.pid),
      bounds: { x: Number(w.x), y: Number(w.y), width: Number(w.width), height: Number(w.height) },
      focused: Boolean(w.focused),
      minimized: Boolean(w.minimized),
      elevated: Boolean(w.elevated),
    }));
  }

  async focusWindow(id: string): Promise<void> {
    await this.json('focusWindow', { id: this.handle(id) });
  }

  async closeWindow(id: string): Promise<void> {
    await this.json('closeWindow', { id: this.handle(id) });
  }

  async launch(request: LaunchRequest): Promise<{ pid?: number }> {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(request.executable)) {
      // Catalog names are plain; anything with a path, space or shell character is not from the catalog.
      throw new AllayaError('That is not a valid application name', { code: 'INVALID_INPUT' });
    }
    const result = await this.json<{ pid: number | null }>(
      'launch',
      { executable: request.executable, arguments: request.arguments ?? [] },
      30_000,
    );
    return result.pid ? { pid: result.pid } : {};
  }

  async installedApps(
    apps: ReadonlyArray<{ name: string; executable: string }>,
  ): Promise<string[]> {
    // Only plain catalog names ever reach the script (as data, never as code).
    const items = apps.filter(
      (a) => /^[A-Za-z0-9._-]{1,64}$/.test(a.executable) && /^[A-Za-z0-9 ._+-]{1,40}$/.test(a.name),
    );
    const result = await this.json<{ installed: string[] | string | null }>(
      'installedApps',
      { items },
      30_000,
    );
    const list = Array.isArray(result.installed)
      ? result.installed
      : result.installed
        ? [result.installed]
        : [];
    const known = new Set(items.map((i) => i.name));
    return list.filter((name) => known.has(name));
  }

  displays(): Promise<DisplayInfo[]> {
    return Promise.reject(
      new AllayaError('Displays are provided by the host', { code: 'UNSUPPORTED_PLATFORM' }),
    );
  }
  screenshot(): Promise<ScreenshotResult> {
    return Promise.reject(
      new AllayaError('Screenshots are provided by the host', { code: 'UNSUPPORTED_PLATFORM' }),
    );
  }
  getClipboardText(): Promise<string> {
    return Promise.reject(
      new AllayaError('The clipboard is provided by the host', { code: 'UNSUPPORTED_PLATFORM' }),
    );
  }
  setClipboardText(): Promise<void> {
    return Promise.reject(
      new AllayaError('The clipboard is provided by the host', { code: 'UNSUPPORTED_PLATFORM' }),
    );
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.json('moveMouse', { x: Math.round(x), y: Math.round(y) });
  }

  async clickMouse(x: number, y: number, button: MouseButton, count: 1 | 2): Promise<void> {
    await this.json('clickMouse', { x: Math.round(x), y: Math.round(y), button, count });
  }

  async scroll(deltaY: number): Promise<void> {
    await this.json('scroll', { delta: Math.round(deltaY) });
  }

  async typeText(text: string): Promise<void> {
    await this.json('typeText', { text }, 60_000);
  }

  async pressKeys(chord: KeyChord): Promise<void> {
    const key = virtualKey(chord.key);
    if (key === undefined)
      throw new AllayaError(`"${chord.key}" is not a key Allaya can press`, {
        code: 'INVALID_INPUT',
      });
    await this.json('pressKeys', { modifiers: chord.modifiers.map((m) => MODIFIER_VK[m]), key });
  }

  async invokeElement(query: ElementQuery): Promise<boolean> {
    const result = await this.json<{ found: boolean }>('invokeElement', {
      windowId: this.handle(query.windowId),
      name: query.name,
      controlType: query.role ?? null,
    });
    return result.found;
  }

  /** Window ids are decimal handles; anything else is rejected before it reaches a script. */
  private handle(id: string): string {
    if (!/^\d{1,20}$/.test(id))
      throw new AllayaError('That is not a valid window id', { code: 'INVALID_INPUT' });
    return id;
  }
}
