import type { ElementInfo } from './page-model';

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface NavigationResult {
  tab: TabInfo;
  /** HTTP status of the final document, when known. */
  status: number | undefined;
  /** Requests the network policy stopped while loading (private addresses, blocked sites). */
  blockedRequests: number;
  /** The address itself was refused (a redirect led somewhere not allowed) and the page did not load. */
  blocked?: string | undefined;
}

export interface ActionResult {
  tab: TabInfo;
  /** The address of the tab changed. */
  navigated: boolean;
  /** A new tab (popup / target=_blank) appeared; it is now the active one. */
  newTab?: TabInfo | undefined;
  /** Text of an alert/confirm/prompt that was dismissed. Page-supplied, so untrusted. */
  dialog?: string | undefined;
  blockedRequests: number;
}

export interface RawSnapshot {
  url: string;
  title: string;
  text: string;
  elements: ElementInfo[];
  /** The page has more interactive elements than were listed. */
  elementsTruncated: boolean;
}

/**
 * One browser, as the engine sees it. The real implementation drives Chromium through Playwright; the in-memory
 * one is a scripted fake web used to test the rules without a network. The session does the work; the *engine*
 * decides what is allowed.
 */
export interface BrowserSession {
  readonly name: string;
  isOpen(): boolean;
  open(
    url: string,
    options: { newTab: boolean; signal?: AbortSignal | undefined },
  ): Promise<NavigationResult>;
  /** Assigns `e<generation>_<n>` refs to the interactive elements of the active tab and describes the page. */
  snapshot(options: {
    generation: number;
    maxChars: number;
    maxElements: number;
  }): Promise<RawSnapshot>;
  click(ref: string, signal?: AbortSignal): Promise<ActionResult>;
  /** Replaces the value of an editable field. Returns the value as the page now holds it (never for secrets). */
  fill(ref: string, text: string): Promise<{ value: string | undefined }>;
  press(key: string, signal?: AbortSignal): Promise<ActionResult>;
  screenshot(): Promise<Uint8Array>;
  tabs(): Promise<TabInfo[]>;
  switchTab(id: string): Promise<TabInfo>;
  closeTab(id: string): Promise<void>;
  back(signal?: AbortSignal): Promise<ActionResult>;
  /** Stops whatever the page is loading (the emergency stop). Never throws. */
  stop(): Promise<void>;
  close(): Promise<void>;
  /** Called when tabs open, close or navigate, so the UI can refresh. */
  onChange(listener: () => void): () => void;
}
