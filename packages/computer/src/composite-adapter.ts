import { AllayaError } from '@allaya/shared';
import {
  NO_CAPABILITIES,
  type ComputerAdapter,
  type ComputerCapabilities,
  type DisplayInfo,
  type ElementQuery,
  type KeyChord,
  type LaunchRequest,
  type MouseButton,
  type ScreenshotResult,
  type WindowInfo,
} from './types';

/** What the host application (Electron) provides on every platform. */
export interface HostServices {
  displays(): Promise<DisplayInfo[]>;
  screenshot(options?: { displayId?: number }): Promise<ScreenshotResult>;
  getClipboardText(): Promise<string>;
  setClipboardText(text: string): Promise<void>;
}

const unsupported = (what: string): never => {
  throw new AllayaError(`${what} is not available on this computer`, {
    code: 'UNSUPPORTED_PLATFORM',
  });
};

/**
 * Combines the host's cross-platform services (screenshots, clipboard, displays) with a platform input adapter
 * (windows, launching, mouse, keyboard). On a platform without an input adapter only the host services exist,
 * and the engine reports the rest as unavailable instead of pretending.
 */
export class CompositeAdapter implements ComputerAdapter {
  readonly platform: NodeJS.Platform;
  readonly name: string;

  constructor(
    private readonly input: ComputerAdapter | undefined,
    private readonly host: HostServices | undefined,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.platform = input?.platform ?? platform;
    this.name = input ? `${input.name}+host` : 'host-only';
  }

  capabilities(): ComputerCapabilities {
    const base = this.input?.capabilities() ?? NO_CAPABILITIES;
    return { ...base, screenshot: this.host !== undefined, clipboard: this.host !== undefined };
  }

  listWindows(): Promise<WindowInfo[]> {
    return this.input ? this.input.listWindows() : unsupported('Listing windows');
  }
  focusWindow(id: string): Promise<void> {
    return this.input ? this.input.focusWindow(id) : unsupported('Focusing windows');
  }
  closeWindow(id: string): Promise<void> {
    return this.input ? this.input.closeWindow(id) : unsupported('Closing windows');
  }
  launch(request: LaunchRequest): Promise<{ pid?: number }> {
    return this.input ? this.input.launch(request) : unsupported('Launching apps');
  }
  displays(): Promise<DisplayInfo[]> {
    return this.host ? this.host.displays() : unsupported('Display information');
  }
  screenshot(options?: { displayId?: number }): Promise<ScreenshotResult> {
    return this.host ? this.host.screenshot(options) : unsupported('Screenshots');
  }
  getClipboardText(): Promise<string> {
    return this.host ? this.host.getClipboardText() : unsupported('The clipboard');
  }
  setClipboardText(text: string): Promise<void> {
    return this.host ? this.host.setClipboardText(text) : unsupported('The clipboard');
  }
  moveMouse(x: number, y: number): Promise<void> {
    return this.input ? this.input.moveMouse(x, y) : unsupported('Mouse control');
  }
  clickMouse(x: number, y: number, button: MouseButton, count: 1 | 2): Promise<void> {
    return this.input ? this.input.clickMouse(x, y, button, count) : unsupported('Mouse control');
  }
  scroll(deltaY: number): Promise<void> {
    return this.input ? this.input.scroll(deltaY) : unsupported('Mouse control');
  }
  typeText(text: string): Promise<void> {
    return this.input ? this.input.typeText(text) : unsupported('Keyboard control');
  }
  pressKeys(chord: KeyChord): Promise<void> {
    return this.input ? this.input.pressKeys(chord) : unsupported('Keyboard control');
  }
  invokeElement(query: ElementQuery): Promise<boolean> {
    return this.input ? this.input.invokeElement(query) : unsupported('UI Automation');
  }
}
