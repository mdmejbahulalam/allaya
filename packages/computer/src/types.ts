/** Everything here is expressed in *screen pixels of the primary coordinate space* unless stated otherwise. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  /** Opaque, adapter-specific handle. Stable while the window exists. */
  id: string;
  title: string;
  /** Lower-case process name without extension, e.g. `chrome`, `notepad`. */
  processName: string;
  pid: number;
  bounds: Rect;
  focused: boolean;
  minimized: boolean;
  /** Runs with administrator rights: input must never be injected into it. */
  elevated?: boolean;
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;
  scaleFactor: number;
  primary: boolean;
}

export interface ScreenshotResult {
  bytes: Uint8Array;
  mimeType: 'image/png';
  width: number;
  height: number;
}

export type MouseButton = 'left' | 'right' | 'middle';

/** A keyboard shortcut such as Ctrl+Shift+T: modifiers held while one key is pressed. */
export interface KeyChord {
  modifiers: Array<'ctrl' | 'shift' | 'alt' | 'win'>;
  key: string;
}

/** What an adapter can actually do on this machine. Tools that need a missing capability are not offered. */
export interface ComputerCapabilities {
  windows: boolean;
  launch: boolean;
  screenshot: boolean;
  clipboard: boolean;
  mouse: boolean;
  keyboard: boolean;
  uiAutomation: boolean;
}

export const NO_CAPABILITIES: ComputerCapabilities = {
  windows: false,
  launch: false,
  screenshot: false,
  clipboard: false,
  mouse: false,
  keyboard: false,
  uiAutomation: false,
};

export interface LaunchRequest {
  /** Executable or App Paths name from the catalog — never text supplied by the model. */
  executable: string;
  arguments?: readonly string[];
}

export interface ElementQuery {
  windowId: string;
  /** The visible name/label of the control. */
  name: string;
  role?: 'button' | 'menuitem' | 'checkbox' | 'radiobutton' | 'tab' | 'link' | 'listitem' | 'edit';
}

/**
 * The seam between Allaya's decisions and the operating system. Everything an adapter does is a primitive
 * (list, focus, click, type); the safety rules, rate limits and verification live in the engine above it.
 */
export interface ComputerAdapter {
  readonly platform: NodeJS.Platform;
  readonly name: string;
  capabilities(): ComputerCapabilities;

  listWindows(): Promise<WindowInfo[]>;
  focusWindow(id: string): Promise<void>;
  /** Asks the window to close (as the ✕ button does). Never kills the process; the app may prompt to save. */
  closeWindow(id: string): Promise<void>;
  launch(request: LaunchRequest): Promise<{ pid?: number }>;

  displays(): Promise<DisplayInfo[]>;
  screenshot(options?: { displayId?: number }): Promise<ScreenshotResult>;

  getClipboardText(): Promise<string>;
  setClipboardText(text: string): Promise<void>;

  moveMouse(x: number, y: number): Promise<void>;
  clickMouse(x: number, y: number, button: MouseButton, count: 1 | 2): Promise<void>;
  scroll(deltaY: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKeys(chord: KeyChord): Promise<void>;
  /** Activates a control found by name through UI Automation. `false` when no such control exists. */
  invokeElement(query: ElementQuery): Promise<boolean>;
}
