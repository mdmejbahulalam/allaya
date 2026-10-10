import { randomBytes } from 'node:crypto';
import {
  WebContentsView,
  session as electronSession,
  type BrowserWindow,
  type WebContents,
} from 'electron';
import { AllayaError, type Logger } from '@allaya/shared';
import type { BrowserHost, BrowserState, Bounds, LoadOptions, TabInfo } from './host';
import { checkAgentUrl } from './url';

/** The web's own storage (logins, cookies) lives here, apart from the app's own pages, and is kept between runs. */
export const WEB_PARTITION = 'persist:allaya-web';

const MAX_TABS = 12;
const LOAD_TIMEOUT_MS = 20_000;
const SCRIPT_TIMEOUT_MS = 15_000;

interface Tab {
  id: string;
  view: WebContentsView;
  /** A load Allaya asked for is under way: a redirect to a private address is stopped. */
  guarded: boolean;
}

export interface ElectronBrowserOptions {
  window: () => BrowserWindow | undefined;
  logger: Logger;
  /** Called when a download was refused, so the screen can say so. */
  onDownloadRefused?: (filename: string) => void;
}

const isWeb = (url: string) => /^https?:\/\//i.test(url);

/**
 * The browser pane, made of real web views stacked over the window. Every page runs in a sandbox with no connection to
 * the app: no preload, no Node, its own storage, every permission refused, downloads refused. The screen only says
 * where the pane is; what is drawn there is the web.
 */
export class ElectronBrowserHost implements BrowserHost {
  private readonly tabs: Tab[] = [];
  private activeId: string | null = null;
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private readonly listeners = new Set<(state: BrowserState) => void>();
  private configured = false;

  constructor(private readonly options: ElectronBrowserOptions) {}

  private configureSession(): void {
    if (this.configured) return;
    this.configured = true;
    const ses = electronSession.fromPartition(WEB_PARTITION);
    // Every permission a page may ask for (camera, microphone, location, notifications…) is refused.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    // Some sites turn away a browser that says it is "Electron"; this is an ordinary Chromium.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|allaya-lite|Allaya)\/[\d.]+/gi, ''));
    ses.on('will-download', (event, item) => {
      event.preventDefault();
      this.options.onDownloadRefused?.(item.getFilename());
    });
  }

  private info(tab: Tab): TabInfo {
    const wc = tab.view.webContents;
    return {
      id: tab.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  state(): BrowserState {
    return { tabs: this.tabs.map((t) => this.info(t)), activeId: this.activeId };
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  private find(id?: string): Tab {
    const tab = this.tabs.find((t) => t.id === (id ?? this.activeId));
    if (!tab) throw new AllayaError('There is no such tab', { code: 'NOT_FOUND' });
    return tab;
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  private create(): Tab {
    if (this.tabs.length >= MAX_TABS) {
      throw new AllayaError('Too many tabs are open. Close one first.', { code: 'LIMIT_EXCEEDED' });
    }
    this.configureSession();
    const view = new WebContentsView({
      webPreferences: {
        partition: WEB_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });
    const tab: Tab = { id: `t_${randomBytes(3).toString('hex')}`, view, guarded: false };
    const wc = view.webContents;

    const changed = () => this.emit();
    wc.on('did-start-loading', changed);
    wc.on('did-stop-loading', () => {
      tab.guarded = false;
      changed();
    });
    wc.on('page-title-updated', changed);
    wc.on('did-navigate', changed);
    wc.on('did-navigate-in-page', changed);

    // Only the web: no file:, no app pages, no scripts-as-addresses, whoever asks.
    const refuseOffWeb = (event: { preventDefault: () => void }, url: string) => {
      if (!isWeb(url)) event.preventDefault();
    };
    wc.on('will-navigate', refuseOffWeb);
    // A load Allaya asked for may not be bounced to this computer or a private network.
    wc.on('will-redirect', (event, url) => {
      refuseOffWeb(event, url);
      if (tab.guarded && !checkAgentUrl(url).ok) {
        event.preventDefault();
        this.options.logger.warn('Stopped a redirect to a private address');
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      const allowed = isWeb(url) && (!tab.guarded || checkAgentUrl(url).ok);
      if (allowed && this.tabs.length < MAX_TABS) {
        void this.open(url, { by: tab.guarded ? 'agent' : 'person' }).catch(() => undefined);
      }
      return { action: 'deny' };
    });
    wc.on('render-process-gone', changed);

    this.tabs.push(tab);
    return tab;
  }

  private waitForLoad(tab: Tab, options: LoadOptions): Promise<void> {
    const wc = tab.view.webContents;
    return new Promise((resolve) => {
      const timeoutMs = options.timeoutMs ?? LOAD_TIMEOUT_MS;
      const timer = setTimeout(() => done(), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        wc.removeListener('did-stop-loading', done);
        wc.removeListener('did-fail-load', failed);
        options.signal?.removeEventListener('abort', done);
        resolve();
      };
      // A main-frame failure is the end of this load too; the person sees the browser's own error page.
      const failed = (
        _e: unknown,
        _code: number,
        _desc: string,
        _url: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame) done();
      };
      wc.on('did-stop-loading', done);
      wc.on('did-fail-load', failed);
      options.signal?.addEventListener('abort', done, { once: true });
      if (!wc.isLoading() && wc.getURL()) done();
    });
  }

  private async load(tab: Tab, url: string, options: LoadOptions): Promise<TabInfo> {
    if (!isWeb(url))
      throw new AllayaError('Only web addresses can be opened', { code: 'INVALID_INPUT' });
    tab.guarded = options.by === 'agent';
    const wc = tab.view.webContents;
    const loaded = this.waitForLoad(tab, options);
    // `loadURL` rejects for a page that fails to load; the browser shows its own error page for that, so it is not an error here.
    void wc.loadURL(url).catch(() => undefined);
    await loaded;
    if (options.signal?.aborted)
      throw options.signal.reason ?? new AllayaError('Cancelled', { code: 'CANCELLED' });
    this.emit();
    return this.info(tab);
  }

  async open(url: string, options: LoadOptions = {}): Promise<TabInfo> {
    const tab = this.create();
    this.activate(tab.id);
    return this.load(tab, url, options);
  }

  async navigate(url: string, options: LoadOptions & { tabId?: string } = {}): Promise<TabInfo> {
    return this.load(this.find(options.tabId), url, options);
  }

  close(tabId: string): void {
    const tab = this.find(tabId);
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    this.detach(tab);
    // A closing tab's web contents are destroyed with the view.
    (tab.view.webContents as WebContents & { close: () => void }).close();
    if (this.activeId === tabId) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activeId = next?.id ?? null;
      this.place();
    }
    this.emit();
  }

  activate(tabId: string): void {
    this.find(tabId);
    if (this.activeId === tabId) return;
    const previous = this.activeId ? this.tabs.find((t) => t.id === this.activeId) : undefined;
    if (previous) this.detach(previous);
    this.activeId = tabId;
    this.place();
    this.emit();
  }

  back(tabId?: string): void {
    const wc = this.find(tabId).view.webContents;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }
  forward(tabId?: string): void {
    const wc = this.find(tabId).view.webContents;
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }
  reload(tabId?: string): void {
    this.find(tabId).view.webContents.reload();
  }
  stop(tabId?: string): void {
    this.find(tabId).view.webContents.stop();
  }

  async evaluate<T>(tabId: string, script: string, signal?: AbortSignal): Promise<T> {
    const wc = this.find(tabId).view.webContents;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        wc.executeJavaScript(script, true) as Promise<T>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AllayaError('The page did not answer in time', { code: 'TIMEOUT' })),
            SCRIPT_TIMEOUT_MS,
          );
          signal?.addEventListener(
            'abort',
            () => reject(new AllayaError('Cancelled', { code: 'CANCELLED' })),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── where it is drawn ─────────────────────────────────────────────────────
  setBounds(bounds: Bounds, visible: boolean): void {
    this.bounds = bounds;
    this.visible = visible;
    this.place();
  }

  private detach(tab: Tab): void {
    const window = this.options.window();
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(tab.view);
      } catch {
        /* it was not attached */
      }
    }
  }

  /** Shows the active tab in the pane, or nothing when the pane is hidden or has no room. */
  private place(): void {
    const window = this.options.window();
    if (!window || window.isDestroyed()) return;
    const active = this.activeId ? this.tabs.find((t) => t.id === this.activeId) : undefined;
    const room = this.bounds.width > 1 && this.bounds.height > 1;
    for (const tab of this.tabs) if (tab !== active || !this.visible || !room) this.detach(tab);
    if (!active || !this.visible || !room) return;
    window.contentView.addChildView(active.view);
    active.view.setBounds({
      x: Math.round(this.bounds.x),
      y: Math.round(this.bounds.y),
      width: Math.round(this.bounds.width),
      height: Math.round(this.bounds.height),
    });
  }

  onChange(listener: (state: BrowserState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const tab of [...this.tabs]) {
      this.detach(tab);
      try {
        (tab.view.webContents as WebContents & { close: () => void }).close();
      } catch {
        /* already gone */
      }
    }
    this.tabs.length = 0;
    this.activeId = null;
    this.listeners.clear();
  }
}
