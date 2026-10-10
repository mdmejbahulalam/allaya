import type { BrowserHost, BrowserState, Bounds, TabInfo } from '@lite/main/browser/host';
import {
  LIST_LINKS_SCRIPT,
  READ_PAGE_SCRIPT,
  SEARCH_RESULTS_SCRIPT,
} from '@lite/main/browser/extract';

export interface FakePage {
  title: string;
  text?: string;
  headings?: string[];
  links?: Array<{ text: string; href: string }>;
  results?: Array<{ title: string; href: string; snippet: string }>;
  /** What the page returns for any script, instead of the usual (a page that lies about its shape). */
  raw?: unknown;
}

/** A browser with a few made-up pages, in memory. It records what was done, so a test can say what happened. */
export class FakeBrowser implements BrowserHost {
  readonly log: string[] = [];
  bounds: { bounds: Bounds; visible: boolean } | undefined;
  private tabs: TabInfo[] = [];
  private active: string | null = null;
  private listeners = new Set<(s: BrowserState) => void>();
  private n = 0;
  /** What each address shows. Anything else is a page with no text. */
  pages = new Map<string, FakePage>();
  /** Makes the next load fail. */
  failNext: Error | undefined;

  state(): BrowserState {
    return { tabs: this.tabs.map((t) => ({ ...t })), activeId: this.active };
  }

  private emit() {
    for (const l of this.listeners) l(this.state());
  }

  private page(url: string): FakePage {
    return this.pages.get(url) ?? { title: '' };
  }

  async open(url: string): Promise<TabInfo> {
    this.log.push(`open ${url}`);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    this.n += 1;
    const tab: TabInfo = {
      id: `t${this.n}`,
      url,
      title: this.page(url).title,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    this.tabs.push(tab);
    this.active = tab.id;
    this.emit();
    return { ...tab };
  }

  async navigate(url: string, options: { tabId?: string } = {}): Promise<TabInfo> {
    const tab = this.find(options.tabId);
    this.log.push(`navigate ${tab.id} ${url}`);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    tab.url = url;
    tab.title = this.page(url).title;
    tab.canGoBack = true;
    this.emit();
    return { ...tab };
  }

  private find(id?: string): TabInfo {
    const tab = this.tabs.find((t) => t.id === (id ?? this.active));
    if (!tab) throw new Error('no such tab');
    return tab;
  }

  close(tabId: string) {
    this.log.push(`close ${tabId}`);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    if (this.active === tabId) this.active = this.tabs.at(-1)?.id ?? null;
    this.emit();
  }
  activate(tabId: string) {
    this.log.push(`activate ${tabId}`);
    this.find(tabId);
    this.active = tabId;
    this.emit();
  }
  back(tabId?: string) {
    this.log.push(`back ${this.find(tabId).id}`);
  }
  forward(tabId?: string) {
    this.log.push(`forward ${this.find(tabId).id}`);
  }
  reload(tabId?: string) {
    this.log.push(`reload ${this.find(tabId).id}`);
  }
  stop(tabId?: string) {
    this.log.push(`stop ${this.find(tabId).id}`);
  }

  evaluate<T>(tabId: string, script: string): Promise<T> {
    const tab = this.find(tabId);
    const page = this.page(tab.url);
    if (page.raw !== undefined) return Promise.resolve(page.raw as T);
    if (script === READ_PAGE_SCRIPT) {
      return Promise.resolve({
        title: page.title,
        text: page.text ?? '',
        headings: page.headings ?? [],
      } as T);
    }
    if (script === LIST_LINKS_SCRIPT) return Promise.resolve((page.links ?? []) as T);
    if (script === SEARCH_RESULTS_SCRIPT) return Promise.resolve((page.results ?? []) as T);
    return Promise.reject(new Error('unexpected script'));
  }

  setBounds(bounds: Bounds, visible: boolean) {
    this.bounds = { bounds, visible };
  }
  onChange(listener: (s: BrowserState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose() {
    this.listeners.clear();
  }
}
