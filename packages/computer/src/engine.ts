import { AllayaError, sleep } from '@allaya/shared';
import { APP_CATALOG, SENSITIVE_PROCESSES, resolveApp, type AppEntry } from './apps';
import { blockedChordReason, formatChord, parseChord } from './keys';
import type {
  ComputerAdapter,
  ComputerCapabilities,
  DisplayInfo,
  ElementQuery,
  KeyChord,
  MouseButton,
  Rect,
  ScreenshotResult,
  WindowInfo,
} from './types';

export const MAX_TYPED_CHARS = 2000;

export interface EngineOptions {
  adapter: ComputerAdapter;
  /** The Allaya process id: Allaya never types or clicks into itself. */
  ownPid?: number;
  now?: () => number;
  /** Input actions allowed per `windowMs` (a runaway loop must not hammer the desktop). */
  rate?: { max: number; windowMs: number };
  /** How long to wait for a window to appear/disappear when verifying. */
  waitMs?: number;
  pollMs?: number;
}

const DEFAULT_RATE = { max: 40, windowMs: 10_000 };

const inRect = (r: Rect, x: number, y: number) =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

const norm = (s: string) => s.toLowerCase().replace(/\.exe$/, '');

/**
 * Wraps an adapter with the rules that make synthetic input safe:
 *  - apps launch only from the catalog (no arbitrary commands);
 *  - synthetic keyboard/mouse input is refused for shells, system tools, elevated windows and Allaya itself;
 *  - shortcuts that leave the window (Win+…, Alt+F4, Ctrl+Alt+Del) are refused;
 *  - typed text is bounded, coordinates must be on a display, and input is rate limited;
 *  - launching and closing are *verified* by looking for the window, not assumed.
 */
export class ComputerEngine {
  private readonly adapter: ComputerAdapter;
  private readonly now: () => number;
  private readonly rate: { max: number; windowMs: number };
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly recent: number[] = [];

  constructor(private readonly options: EngineOptions) {
    this.adapter = options.adapter;
    this.now = options.now ?? Date.now;
    this.rate = options.rate ?? DEFAULT_RATE;
    this.waitMs = options.waitMs ?? 8000;
    this.pollMs = options.pollMs ?? 250;
  }

  get name(): string {
    return this.adapter.name;
  }
  get platform(): NodeJS.Platform {
    return this.adapter.platform;
  }
  capabilities(): ComputerCapabilities {
    return this.adapter.capabilities();
  }

  // ── observation ─────────────────────────────────────────────────────────────
  async listWindows(): Promise<WindowInfo[]> {
    this.require('windows');
    return this.adapter.listWindows();
  }

  async displays(): Promise<DisplayInfo[]> {
    this.require('screenshot');
    return this.adapter.displays();
  }

  async screenshot(displayId?: number): Promise<ScreenshotResult> {
    this.require('screenshot');
    return this.adapter.screenshot(displayId === undefined ? undefined : { displayId });
  }

  async setClipboard(text: string): Promise<void> {
    this.require('clipboard');
    await this.adapter.setClipboardText(text);
  }

  async getClipboardText(): Promise<string> {
    this.require('clipboard');
    return this.adapter.getClipboardText();
  }

  // ── applications and windows ────────────────────────────────────────────────
  /** Windows belonging to a catalog app. */
  async windowsOf(app: AppEntry): Promise<WindowInfo[]> {
    const wanted = new Set(app.processes.map(norm));
    return (await this.listWindows()).filter((w) => wanted.has(norm(w.processName)));
  }

  /**
   * Which catalog apps are installed, or `undefined` when this machine's adapter cannot tell (then callers say
   * "unknown" instead of guessing).
   */
  async installedApps(): Promise<Set<string> | undefined> {
    if (!this.adapter.installedApps) return undefined;
    try {
      const names = await this.adapter.installedApps(
        APP_CATALOG.map((a) => ({ name: a.name, executable: a.windows })),
      );
      return new Set(names);
    } catch {
      return undefined;
    }
  }

  /** Launches a catalog app and waits for its window. `window` is `undefined` if it did not appear in time. */
  async openApp(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ app: AppEntry; window: WindowInfo | undefined; alreadyOpen: boolean }> {
    this.require('launch');
    const app = resolveApp(name);
    if (!app) {
      throw new AllayaError(`"${name.slice(0, 60)}" is not an app Allaya knows how to open`, {
        code: 'NOT_FOUND',
        details: { app: name.slice(0, 60) },
      });
    }
    const before = this.capabilities().windows ? await this.windowsOf(app) : [];
    await this.adapter.launch({ executable: app.windows });
    if (!this.capabilities().windows) return { app, window: undefined, alreadyOpen: false };
    const known = new Set(before.map((w) => w.id));
    const window = await this.waitFor(async () => {
      const now = await this.windowsOf(app);
      // A window that was not there before, or (single-instance apps) any window if one was already open.
      return now.find((w) => !known.has(w.id)) ?? (before.length > 0 ? now[0] : undefined);
    }, signal);
    return { app, window, alreadyOpen: before.length > 0 };
  }

  /** Asks an app's windows to close, then checks they are gone. Never force-kills. */
  async closeApp(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ app: AppEntry; closed: number; remaining: number }> {
    this.require('windows');
    const app = resolveApp(name);
    if (!app) {
      throw new AllayaError(`"${name.slice(0, 60)}" is not an app Allaya knows`, {
        code: 'NOT_FOUND',
        details: { app: name.slice(0, 60) },
      });
    }
    const windows = (await this.windowsOf(app)).filter((w) => w.pid !== this.options.ownPid);
    if (windows.length === 0)
      throw new AllayaError(`${app.name} is not open`, {
        code: 'NOT_FOUND',
        details: { app: app.name },
      });
    for (const window of windows) await this.adapter.closeWindow(window.id);
    const ids = new Set(windows.map((w) => w.id));
    const gone = await this.waitFor(
      async () => ((await this.windowsOf(app)).every((w) => !ids.has(w.id)) ? true : undefined),
      signal,
    );
    const remaining = gone ? 0 : (await this.windowsOf(app)).filter((w) => ids.has(w.id)).length;
    return { app, closed: windows.length - remaining, remaining };
  }

  async focusWindow(windowId: string): Promise<WindowInfo> {
    this.require('windows');
    const window = await this.requireWindow(windowId);
    if (window.pid === this.options.ownPid)
      throw new AllayaError('Allaya does not control its own window', {
        code: 'PERMISSION_DENIED',
      });
    await this.adapter.focusWindow(window.id);
    const after = await this.waitFor(async () => {
      const found = (await this.adapter.listWindows()).find((w) => w.id === window.id);
      return found?.focused ? found : undefined;
    });
    return after ?? window;
  }

  // ── input ───────────────────────────────────────────────────────────────────
  async typeText(text: string, windowId?: string): Promise<{ target: WindowInfo }> {
    this.require('keyboard');
    if (text.length === 0)
      throw new AllayaError('There is no text to type', { code: 'INVALID_INPUT' });
    if (text.length > MAX_TYPED_CHARS) {
      throw new AllayaError(`That is too much text to type (limit ${MAX_TYPED_CHARS} characters)`, {
        code: 'INVALID_INPUT',
      });
    }
    const target = await this.prepareInputTarget(windowId);
    this.consumeRate();
    await this.adapter.typeText(text);
    return { target };
  }

  async pressKeys(
    chordText: string,
    windowId?: string,
  ): Promise<{ target: WindowInfo; chord: KeyChord }> {
    this.require('keyboard');
    const chord = parseChord(chordText);
    const blocked = blockedChordReason(chord);
    if (blocked)
      throw new AllayaError(blocked, {
        code: 'PERMISSION_DENIED',
        details: { chord: formatChord(chord) },
      });
    const target = await this.prepareInputTarget(windowId);
    this.consumeRate();
    await this.adapter.pressKeys(chord);
    return { target, chord };
  }

  async click(x: number, y: number, button: MouseButton = 'left', count: 1 | 2 = 1): Promise<void> {
    this.require('mouse');
    const displays = await this.adapter.displays();
    if (!displays.some((d) => inRect(d.bounds, x, y))) {
      throw new AllayaError(`(${x}, ${y}) is not on any screen`, { code: 'INVALID_INPUT' });
    }
    const windows = this.capabilities().windows ? await this.adapter.listWindows() : [];
    const blockedWindow = windows.find(
      (w) => !w.minimized && this.isOffLimits(w) && inRect(w.bounds, x, y),
    );
    if (blockedWindow) {
      throw new AllayaError(
        `That spot is inside ${blockedWindow.processName}, which Allaya is not allowed to control`,
        {
          code: 'PERMISSION_DENIED',
          details: { process: blockedWindow.processName },
        },
      );
    }
    this.consumeRate();
    await this.adapter.clickMouse(x, y, button, count);
  }

  async scroll(deltaY: number): Promise<void> {
    this.require('mouse');
    if (!Number.isFinite(deltaY) || deltaY === 0 || Math.abs(deltaY) > 5000) {
      throw new AllayaError('Scroll amount must be a non-zero number up to 5000', {
        code: 'INVALID_INPUT',
      });
    }
    this.consumeRate();
    await this.adapter.scroll(deltaY);
  }

  async invokeElement(query: ElementQuery): Promise<boolean> {
    this.require('uiAutomation');
    const window = await this.requireWindow(query.windowId);
    this.assertControllable(window);
    this.consumeRate();
    return this.adapter.invokeElement({ ...query, windowId: window.id });
  }

  // ── safety helpers ──────────────────────────────────────────────────────────
  /** Focuses the requested window (if any) and checks the window that will actually receive the input. */
  private async prepareInputTarget(windowId: string | undefined): Promise<WindowInfo> {
    if (windowId !== undefined) await this.focusWindow(windowId);
    const windows = await this.adapter.listWindows();
    const focused = windows.find((w) => w.focused);
    if (!focused)
      throw new AllayaError('No window has focus, so there is nowhere to send input', {
        code: 'TOOL_EXECUTION_FAILED',
      });
    if (windowId !== undefined && focused.id !== windowId) {
      throw new AllayaError('The window could not be brought to the front, so no input was sent', {
        code: 'TOOL_EXECUTION_FAILED',
      });
    }
    this.assertControllable(focused);
    return focused;
  }

  private isOffLimits(window: WindowInfo): boolean {
    return (
      window.elevated === true ||
      window.pid === this.options.ownPid ||
      SENSITIVE_PROCESSES.has(norm(window.processName))
    );
  }

  /** Refuses shells, system tools, elevated windows and Allaya itself. */
  assertControllable(window: WindowInfo): void {
    if (window.pid === this.options.ownPid) {
      throw new AllayaError('Allaya does not control its own window', {
        code: 'PERMISSION_DENIED',
      });
    }
    if (window.elevated) {
      throw new AllayaError(
        `"${window.title || window.processName}" is running as administrator; Allaya will not send it input`,
        {
          code: 'PERMISSION_DENIED',
          details: { process: window.processName },
        },
      );
    }
    if (SENSITIVE_PROCESSES.has(norm(window.processName))) {
      throw new AllayaError(
        `${window.processName} can run commands or change the system, so Allaya will not type or click into it`,
        { code: 'PERMISSION_DENIED', details: { process: window.processName } },
      );
    }
  }

  private consumeRate(): void {
    const now = this.now();
    while (this.recent.length > 0 && now - this.recent[0]! >= this.rate.windowMs)
      this.recent.shift();
    if (this.recent.length >= this.rate.max) {
      throw new AllayaError('Too many input actions in a short time; slowing down', {
        code: 'TOOL_EXECUTION_FAILED',
        retryable: true,
      });
    }
    this.recent.push(now);
  }

  private require(capability: keyof ComputerCapabilities): void {
    if (!this.capabilities()[capability]) {
      throw new AllayaError(
        `This computer control feature (${capability}) is not available on ${this.adapter.platform}`,
        {
          code: 'UNSUPPORTED_PLATFORM',
          details: { capability },
        },
      );
    }
  }

  private async requireWindow(id: string): Promise<WindowInfo> {
    const window = (await this.adapter.listWindows()).find((w) => w.id === id);
    if (!window) throw new AllayaError('That window no longer exists', { code: 'NOT_FOUND' });
    return window;
  }

  /** Polls until `probe` returns something, or the wait budget runs out (`undefined`). */
  private async waitFor<T>(
    probe: () => Promise<T | undefined>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const deadline = this.now() + this.waitMs;
    for (;;) {
      const found = await probe();
      if (found !== undefined) return found;
      if (this.now() >= deadline) return undefined;
      await sleep(this.pollMs, signal);
    }
  }
}
