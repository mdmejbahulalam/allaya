/** One tab of the built-in browser, as the rest of the app sees it. */
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserState {
  tabs: TabInfo[];
  activeId: string | null;
}

export interface LoadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Who asked. A load the model asked for may not be taken to a private address by a redirect; one the person asked for
   * may go anywhere on the web.
   */
  by?: 'agent' | 'person';
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the tools and the screen need from a browser. Electron implements it with real web views; a test implements it
 * with a few made-up pages. Nothing above this line knows which.
 */
export interface BrowserHost {
  state(): BrowserState;
  /** Opens a tab (and makes it the active one); resolves when its first load has ended or `timeoutMs` passed. */
  open(url: string, options?: LoadOptions): Promise<TabInfo>;
  /** Goes to an address in a tab (the active one by default); resolves when the load has ended or `timeoutMs` passed. */
  navigate(url: string, options?: LoadOptions & { tabId?: string }): Promise<TabInfo>;
  close(tabId: string): void;
  activate(tabId: string): void;
  back(tabId?: string): void;
  forward(tabId?: string): void;
  reload(tabId?: string): void;
  stop(tabId?: string): void;
  /** Runs a function in the page and returns what it returns (a plain value). The page is not trusted. */
  evaluate<T>(tabId: string, script: string, signal?: AbortSignal): Promise<T>;
  /** Where on the window the active tab is drawn, and whether it is shown. */
  setBounds(bounds: Bounds, visible: boolean): void;
  onChange(listener: (state: BrowserState) => void): () => void;
  dispose(): void;
}
