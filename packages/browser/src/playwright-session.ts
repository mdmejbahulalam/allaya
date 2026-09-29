import { mkdirSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { AllayaError } from '@allaya/shared';
import type { ElementInfo } from './page-model';
import { BLOCKED_HEADER, PROXY_ERROR_HEADER, type SafeProxy } from './safe-proxy';
import type {
  ActionResult,
  BrowserSession,
  NavigationResult,
  RawSnapshot,
  TabInfo,
} from './session';
import { SNAPSHOT_SOURCE } from './snapshot-script';

export interface PlaywrightSessionOptions {
  /** Allaya's own browser profile (cookies, saved sign-ins). Kept apart from the user's everyday profile. */
  profileDir: string;
  /** The installed Edge/Chrome to drive. */
  executablePath: string;
  /**
   * Every connection the browser makes goes through this proxy, which applies the network rules. The browser is
   * started so that it has no other way out (no direct connections, no local name resolution, no UDP).
   */
  proxy: SafeProxy;
  /** Visible to the user (default) or invisible. */
  headless: boolean;
  /** Only for environments where Chromium cannot use its sandbox (a container running as root). */
  noSandbox?: boolean;
  /** Extra browser switches. */
  extraArgs?: string[];
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
}

const REF = /^e\d{1,6}_\d{1,4}$/;

const friendly = (error: unknown, doing: string): AllayaError => {
  if (error instanceof AllayaError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const make = (
    text: string,
    code: AllayaError['code'] = 'TOOL_EXECUTION_FAILED',
    retryable = false,
  ) => new AllayaError(text, { code, retryable, cause: error });
  if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/.test(message))
    return make('That site could not be found');
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message))
    return make('The site could not be reached');
  if (
    /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/.test(
      message,
    )
  ) {
    return make('The site did not respond', 'TOOL_EXECUTION_FAILED', true);
  }
  if (/ERR_CERT|ERR_SSL|SSL_ERROR|ERR_BAD_SSL/.test(message))
    return make("The site's security certificate is not valid, so it was not opened");
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE/.test(message))
    return make('The site answered with an error and no page');
  if (/ERR_UNSAFE_PORT/.test(message))
    return make('That port is not one a web browser is allowed to use');
  if (/Download is starting/i.test(message))
    return make('That address is a file download, which Allaya blocks');
  if (
    /intercepts pointer events|not visible|not enabled|not stable|detached|outside of the viewport/i.test(
      message,
    ) ||
    (/Timeout \d+ms exceeded/i.test(message) && /^click/.test(doing))
  ) {
    return make(
      'That element could not be clicked: something may be covering it, or it is not ready',
      'TOOL_EXECUTION_FAILED',
      true,
    );
  }
  if (/Timeout \d+ms exceeded/i.test(message) || /timed out/i.test(message))
    return make(`The page took too long (${doing})`, 'TIMEOUT', true);
  if (
    /intercepts pointer events|not visible|not enabled|not stable|detached|outside of the viewport/i.test(
      message,
    )
  ) {
    return make(
      'That element could not be clicked: something is covering it, or it is not available right now',
      'TOOL_EXECUTION_FAILED',
      true,
    );
  }
  if (/not an <input>|Element is not an|cannot be filled|not editable/i.test(message))
    return make('That is not a place where text can be typed', 'INVALID_INPUT');
  if (/Target (page|closed)|has been closed|browser has been closed/i.test(message))
    return make('The browser window was closed');
  return make(`The browser could not ${doing}`);
};

/**
 * Chromium driven through Playwright, in Allaya's own persistent profile.
 *
 * The network rules are NOT enforced here (Playwright's request interception does not see redirect hops, so it
 * cannot be the guard). They are enforced by the proxy the browser is forced through. This class refuses the
 * rest: downloads, file pickers, permission prompts, service workers and page dialogs.
 */
export class PlaywrightSession implements BrowserSession {
  readonly name = 'playwright';
  private open_ = true;
  private active: Page | undefined;
  private readonly ids = new WeakMap<Page, string>();
  private counter = 0;
  private readonly listeners = new Set<() => void>();
  private lastDialog: string | undefined;

  private constructor(
    private readonly context: BrowserContext,
    private readonly options: PlaywrightSessionOptions,
  ) {}

  static async launch(options: PlaywrightSessionOptions): Promise<PlaywrightSession> {
    mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(options.profileDir, {
        executablePath: options.executablePath,
        headless: options.headless,
        chromiumSandbox: !options.noSandbox,
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
        viewport: options.headless ? { width: 1280, height: 800 } : null,
        ignoreHTTPSErrors: false,
        args: [
          `--proxy-server=${options.proxy.url}`,
          // Chromium normally skips the proxy for loopback addresses; this sends them through it (to be refused).
          '--proxy-bypass-list=<-loopback>',
          // Belt and braces: the browser resolves no names itself, so nothing reaches the network without the proxy.
          // (`EXCLUDE 127.0.0.1` keeps the connection to the proxy itself working.)
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-default-apps',
          '--disable-client-side-phishing-detection',
          '--no-first-run',
          '--no-default-browser-check',
          '--password-store=basic',
          '--disable-quic',
          '--webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--force-webrtc-ip-handling-policy',
          ...(options.extraArgs ?? []),
          ...(options.headless ? [] : ['--start-maximized']),
        ],
        timeout: 30_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ProcessSingleton|profile.*in use|already running|SingletonLock/i.test(message)) {
        throw new AllayaError("Allaya's browser is already open in another window", {
          code: 'CONFLICT',
          cause: error,
        });
      }
      throw new AllayaError('The browser could not be started', {
        code: 'TOOL_EXECUTION_FAILED',
        cause: error,
      });
    }
    const session = new PlaywrightSession(context, options);
    session.wire();
    return session;
  }

  private wire(): void {
    this.context.on('page', (page) => this.track(page));
    this.context.on('close', () => {
      this.open_ = false;
      this.emit();
    });
    for (const page of this.context.pages()) this.track(page);
  }

  private track(page: Page): void {
    this.counter += 1;
    this.ids.set(page, `tab-${this.counter}`);
    page.on('dialog', (dialog) => {
      // Page dialogs are the page talking to the user; Allaya does not answer them, it dismisses them.
      this.lastDialog = dialog.message();
      void dialog.dismiss().catch(() => undefined);
    });
    page.on('download', (download) => void download.cancel().catch(() => undefined));
    page.on('filechooser', () => undefined); // never answered: no file is ever offered to a page
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.emit();
    });
    page.on('close', () => {
      if (this.active === page) this.active = undefined;
      this.emit();
    });
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  isOpen(): boolean {
    return this.open_;
  }

  private livePages(): Page[] {
    return this.context.pages().filter((page) => !page.isClosed());
  }

  private async page(): Promise<Page> {
    if (this.active && !this.active.isClosed()) return this.active;
    const existing = this.livePages();
    this.active = existing.at(-1) ?? (await this.context.newPage());
    return this.active;
  }

  private idOf(page: Page): string {
    return this.ids.get(page) ?? 'tab-0';
  }

  private async info(page: Page): Promise<TabInfo> {
    const title = await Promise.race([
      page.title().catch(() => ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 1500)),
    ]);
    return { id: this.idOf(page), url: page.url(), title, active: page === this.active };
  }

  /** What the proxy refused since `since`: a count, and the last site. */
  private blocksSince(since: number): { count: number; last: string | undefined } {
    const blocks = this.options.proxy.blocksSince(since);
    return { count: blocks.length, last: blocks.at(-1)?.host };
  }

  /** Stops loading when `signal` aborts, so a cancelled action does not keep working in the background. */
  private guard<T>(page: Page, signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        void page.evaluate('window.stop()').catch(() => undefined);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new AllayaError('Cancelled', { code: 'CANCELLED' }),
        );
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private unreachable(notFound: boolean): AllayaError {
    return new AllayaError(notFound ? 'That site could not be found' : 'The site did not respond', {
      code: notFound ? 'NOT_FOUND' : 'TOOL_EXECUTION_FAILED',
      retryable: !notFound,
    });
  }

  async open(
    url: string,
    options: { newTab: boolean; signal?: AbortSignal | undefined },
  ): Promise<NavigationResult> {
    options.signal?.throwIfAborted();
    const page = options.newTab ? await this.context.newPage() : await this.page();
    this.active = page;
    // A failed load leaves Chromium's error page behind, which can interrupt the next navigation: clear it first.
    if (page.url().startsWith('chrome-error:'))
      await page.goto('about:blank').catch(() => undefined);
    const since = Date.now();
    const blockedResult = async (site: string): Promise<NavigationResult> => {
      // Leave no error page behind in the tab.
      await page.goto('about:blank').catch(() => undefined);
      return {
        tab: await this.info(page),
        status: undefined,
        blockedRequests: this.blocksSince(since).count,
        blocked: site,
      };
    };
    try {
      const response = await this.guard(
        page,
        options.signal,
        page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: this.options.navigationTimeoutMs ?? 30_000,
        }),
      );
      // A redirect to somewhere forbidden ends in the proxy's refusal, which carries a marker header.
      if (response?.headers()[BLOCKED_HEADER]) {
        return blockedResult(this.blocksSince(since).last ?? 'a blocked address');
      }
      // A site that does not exist or is down: the proxy answered in its place, and recorded why.
      const failure = this.options.proxy.failuresSince(since).at(-1);
      const proxyError =
        response?.headers()[PROXY_ERROR_HEADER] ??
        (response?.status() === 502 ? failure?.kind : undefined);
      if (proxyError) {
        await page.goto('about:blank').catch(() => undefined);
        throw this.unreachable(proxyError === 'not_found');
      }
      await page.waitForLoadState('load', { timeout: 4000 }).catch(() => undefined);
      return {
        tab: await this.info(page),
        status: response?.status(),
        blockedRequests: this.blocksSince(since).count,
      };
    } catch (error) {
      if (error instanceof AllayaError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) {
        // The proxy refused the tunnel: either policy (blocked) or the site could not be reached.
        const blocked = this.blocksSince(since);
        if (blocked.last) return blockedResult(blocked.last);
        const failure = this.options.proxy.failuresSince(since).at(-1);
        if (failure) {
          await page.goto('about:blank').catch(() => undefined);
          throw this.unreachable(failure.kind === 'not_found');
        }
      }
      if (page.url().startsWith('chrome-error:'))
        await page.goto('about:blank').catch(() => undefined);
      throw friendly(error, 'load that page');
    }
  }

  async snapshot(options: {
    generation: number;
    maxChars: number;
    maxElements: number;
  }): Promise<RawSnapshot> {
    const page = await this.page();
    try {
      // The script is a constant; the only inputs are three integers.
      const args = JSON.stringify({
        generation: Math.trunc(options.generation),
        maxElements: Math.trunc(options.maxElements),
        maxChars: Math.trunc(options.maxChars),
      });
      return await page.evaluate<RawSnapshot & { elements: ElementInfo[] }>(
        `(${SNAPSHOT_SOURCE})(${args})`,
      );
    } catch (error) {
      throw friendly(error, 'read the page');
    }
  }

  private locator(page: Page, ref: string) {
    if (!REF.test(ref))
      throw new AllayaError('Invalid element reference', { code: 'INVALID_INPUT' });
    return page.locator(`[data-allaya-ref="${ref}"]`);
  }

  private gone(): AllayaError {
    return new AllayaError('That element is no longer on the page. Read the page again.', {
      code: 'NOT_FOUND',
      details: { reason: 'element_gone' },
    });
  }

  /** What changed on screen after an action: address, new tabs, dismissed dialogs, blocked requests. */
  private async settle(
    page: Page,
    before: { url: string; pages: Set<Page>; since: number },
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300)); // a popup opens a moment after the click
    signal?.throwIfAborted();
    const opened = this.livePages().filter((p) => !before.pages.has(p));
    const newest = opened.at(-1);
    if (newest) {
      this.active = newest;
      await newest.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    }
    const current = this.active && !this.active.isClosed() ? this.active : page;
    const dialog = this.lastDialog;
    this.lastDialog = undefined;
    return {
      tab: await this.info(current),
      navigated: !newest && current.url() !== before.url,
      ...(newest ? { newTab: await this.info(newest) } : {}),
      ...(dialog ? { dialog } : {}),
      blockedRequests: this.blocksSince(before.since).count,
    };
  }

  private snapshotBefore(page: Page) {
    return { url: page.url(), pages: new Set(this.livePages()), since: Date.now() };
  }

  async click(ref: string, signal?: AbortSignal): Promise<ActionResult> {
    const page = await this.page();
    const target = this.locator(page, ref);
    if ((await target.count()) === 0) throw this.gone();
    const before = this.snapshotBefore(page);
    try {
      await this.guard(
        page,
        signal,
        target.first().click({ timeout: this.options.actionTimeoutMs ?? 10_000 }),
      );
    } catch (error) {
      throw friendly(error, 'click that');
    }
    return this.settle(page, before, signal);
  }

  async fill(ref: string, text: string): Promise<{ value: string | undefined }> {
    const page = await this.page();
    const target = this.locator(page, ref);
    if ((await target.count()) === 0) throw this.gone();
    try {
      await target.first().fill(text, { timeout: this.options.actionTimeoutMs ?? 10_000 });
      return {
        value: await target
          .first()
          .inputValue({ timeout: 2000 })
          .catch(() => undefined),
      };
    } catch (error) {
      throw friendly(error, 'type there');
    }
  }

  async press(key: string, signal?: AbortSignal): Promise<ActionResult> {
    const page = await this.page();
    const before = this.snapshotBefore(page);
    try {
      await this.guard(page, signal, page.keyboard.press(key));
    } catch (error) {
      throw friendly(error, 'press that key');
    }
    return this.settle(page, before, signal);
  }

  async screenshot(): Promise<Uint8Array> {
    const page = await this.page();
    try {
      return new Uint8Array(await page.screenshot({ type: 'png', timeout: 15_000 }));
    } catch (error) {
      throw friendly(error, 'take a screenshot');
    }
  }

  async tabs(): Promise<TabInfo[]> {
    return Promise.all(this.livePages().map((page) => this.info(page)));
  }

  private byId(id: string): Page {
    const page = this.livePages().find((p) => this.idOf(p) === id);
    if (!page) throw new AllayaError('There is no such tab', { code: 'NOT_FOUND' });
    return page;
  }

  async switchTab(id: string): Promise<TabInfo> {
    const page = this.byId(id);
    this.active = page;
    await page.bringToFront().catch(() => undefined);
    this.emit();
    return this.info(page);
  }

  async closeTab(id: string): Promise<void> {
    await this.byId(id).close({ runBeforeUnload: false });
  }

  async back(signal?: AbortSignal): Promise<ActionResult> {
    const page = await this.page();
    const before = this.snapshotBefore(page);
    try {
      await this.guard(
        page,
        signal,
        page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }),
      );
    } catch (error) {
      throw friendly(error, 'go back');
    }
    return this.settle(page, before, signal);
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.livePages().map((page) =>
        Promise.race([
          page.evaluate('window.stop()').catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]),
      ),
    );
  }

  async close(): Promise<void> {
    this.open_ = false;
    await this.context.close().catch(() => undefined);
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
