import { AllayaError } from '@allaya/shared';
import type { ElementInfo, ElementRole } from './page-model';
import type {
  ActionResult,
  BrowserSession,
  NavigationResult,
  RawSnapshot,
  TabInfo,
} from './session';

export interface MemoryElement {
  role: ElementRole;
  name: string;
  tag?: string;
  inputType?: string;
  autocomplete?: string;
  /** Clicking a link goes here. */
  href?: string;
  /** `target=_blank`. */
  opensNewTab?: boolean;
  inForm?: boolean;
  disabled?: boolean;
  value?: string;
  /** Pressing Enter in this field (or clicking this button) goes here, like submitting a form. */
  submitTo?: string;
  /** An alert() the click raises. */
  dialog?: string;
}

export interface MemoryPage {
  title: string;
  text: string;
  status?: number;
  elements?: MemoryElement[];
  /** Like an HTTP redirect. */
  redirectTo?: string;
}

interface Tab {
  id: string;
  history: string[];
  index: number;
  refs: Map<string, MemoryElement>;
  focused?: MemoryElement | undefined;
}

let counter = 0;

/**
 * A scripted web for tests: pages, links, forms, redirects and popups, with no network. It applies the same
 * request check the real session applies (so a redirect into a private address is stopped here too) and records
 * what was done to it.
 */
export class MemoryBrowser implements BrowserSession {
  readonly name = 'memory';
  private open_ = true;
  private readonly tabsList: Tab[] = [];
  private active = 0;
  private readonly listeners = new Set<() => void>();
  readonly clicked: string[] = [];
  readonly typed: Array<{ name: string; text: string }> = [];
  readonly pressed: string[] = [];
  readonly visited: string[] = [];
  /** Set to make navigation take this long, so cancellation can be tested. */
  slowMs = 0;
  stopped = 0;

  constructor(
    private readonly web: Record<string, MemoryPage>,
    private readonly checkRequest: (url: string) => Promise<string | undefined> = () =>
      Promise.resolve(undefined),
  ) {
    this.tabsList.push(this.newTab());
  }

  private newTab(): Tab {
    counter += 1;
    return { id: `tab-${counter}`, history: ['about:blank'], index: 0, refs: new Map() };
  }

  private get tab(): Tab {
    return this.tabsList[this.active]!;
  }

  private info(tab: Tab): TabInfo {
    const url = tab.history[tab.index]!;
    return {
      id: tab.id,
      url,
      title: this.web[url]?.title ?? (url === 'about:blank' ? '' : 'Not found'),
      active: this.tabsList[this.active] === tab,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  isOpen(): boolean {
    return this.open_;
  }

  private async navigate(tab: Tab, url: string, signal?: AbortSignal): Promise<NavigationResult> {
    let blockedRequests = 0;
    let current = url;
    for (let hops = 0; hops < 10; hops += 1) {
      if (this.slowMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.slowMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new AllayaError('cancelled', { code: 'CANCELLED' }),
            );
          });
        });
      }
      const verdict = await this.checkRequest(current);
      if (verdict) {
        blockedRequests += 1;
        return { tab: this.info(tab), status: undefined, blockedRequests, blocked: current };
      }
      const page = this.web[current];
      if (page?.redirectTo) {
        current = page.redirectTo;
        continue;
      }
      tab.history = [...tab.history.slice(0, tab.index + 1), current];
      tab.index = tab.history.length - 1;
      tab.refs = new Map();
      this.visited.push(current);
      this.emit();
      return { tab: this.info(tab), status: page ? (page.status ?? 200) : 404, blockedRequests };
    }
    throw new AllayaError('Too many redirects', { code: 'TOOL_EXECUTION_FAILED' });
  }

  async open(
    url: string,
    options: { newTab: boolean; signal?: AbortSignal | undefined },
  ): Promise<NavigationResult> {
    let tab = this.tab;
    if (options.newTab) {
      tab = this.newTab();
      this.tabsList.push(tab);
      this.active = this.tabsList.length - 1;
    }
    if (url === 'about:blank') {
      tab.history = [...tab.history.slice(0, tab.index + 1), 'about:blank'];
      tab.index = tab.history.length - 1;
      this.emit();
      return { tab: this.info(tab), status: undefined, blockedRequests: 0 };
    }
    return this.navigate(tab, url, options.signal);
  }

  snapshot(options: {
    generation: number;
    maxChars: number;
    maxElements: number;
  }): Promise<RawSnapshot> {
    const tab = this.tab;
    const url = tab.history[tab.index]!;
    const page = this.web[url];
    tab.refs = new Map();
    const source = page?.elements ?? [];
    const elements: ElementInfo[] = source.slice(0, options.maxElements).map((el, i) => {
      const ref = `e${options.generation}_${i + 1}`;
      tab.refs.set(ref, el);
      return {
        ref,
        role: el.role,
        name: el.name,
        tag: el.tag ?? (el.role === 'link' ? 'a' : el.role === 'button' ? 'button' : 'input'),
        inputType: el.inputType,
        autocomplete: el.autocomplete,
        href: el.href,
        disabled: el.disabled ?? false,
        value: el.value,
        inForm: el.inForm ?? false,
      };
    });
    return Promise.resolve({
      url,
      title: page?.title ?? '',
      text: page?.text ?? 'Not found',
      elements,
      elementsTruncated: source.length > options.maxElements,
    });
  }

  private element(ref: string): MemoryElement {
    const el = this.tab.refs.get(ref);
    if (!el)
      throw new AllayaError('That element is no longer on the page', {
        code: 'NOT_FOUND',
        details: { reason: 'element_gone' },
      });
    return el;
  }

  private async follow(
    el: MemoryElement,
    target: string,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    const before = this.info(this.tab).url;
    if (el.opensNewTab) {
      const tab = this.newTab();
      this.tabsList.push(tab);
      this.active = this.tabsList.length - 1;
      const nav = await this.navigate(tab, target, signal);
      return {
        tab: nav.tab,
        navigated: false,
        newTab: nav.tab,
        blockedRequests: nav.blockedRequests,
      };
    }
    const nav = await this.navigate(this.tab, target, signal);
    return {
      tab: nav.tab,
      navigated: nav.tab.url !== before,
      blockedRequests: nav.blockedRequests,
    };
  }

  async click(ref: string, signal?: AbortSignal): Promise<ActionResult> {
    const el = this.element(ref);
    this.clicked.push(el.name);
    const target = el.href ?? el.submitTo;
    if (target) {
      const result = await this.follow(el, target, signal);
      return el.dialog ? { ...result, dialog: el.dialog } : result;
    }
    return {
      tab: this.info(this.tab),
      navigated: false,
      blockedRequests: 0,
      ...(el.dialog ? { dialog: el.dialog } : {}),
    };
  }

  fill(ref: string, text: string): Promise<{ value: string | undefined }> {
    const el = this.element(ref);
    el.value = text;
    this.tab.focused = el;
    this.typed.push({ name: el.name, text });
    return Promise.resolve({ value: el.inputType === 'password' ? undefined : text });
  }

  async press(key: string, signal?: AbortSignal): Promise<ActionResult> {
    this.pressed.push(key);
    const focused = this.tab.focused;
    if (key === 'Enter' && focused?.submitTo) return this.follow(focused, focused.submitTo, signal);
    return { tab: this.info(this.tab), navigated: false, blockedRequests: 0 };
  }

  screenshot(): Promise<Uint8Array> {
    return Promise.resolve(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    );
  }

  tabs(): Promise<TabInfo[]> {
    return Promise.resolve(this.tabsList.map((tab) => this.info(tab)));
  }

  switchTab(id: string): Promise<TabInfo> {
    const index = this.tabsList.findIndex((tab) => tab.id === id);
    if (index < 0) return Promise.reject(new AllayaError('No such tab', { code: 'NOT_FOUND' }));
    this.active = index;
    this.emit();
    return Promise.resolve(this.info(this.tab));
  }

  closeTab(id: string): Promise<void> {
    const index = this.tabsList.findIndex((tab) => tab.id === id);
    if (index < 0) return Promise.reject(new AllayaError('No such tab', { code: 'NOT_FOUND' }));
    this.tabsList.splice(index, 1);
    if (this.tabsList.length === 0) this.tabsList.push(this.newTab());
    this.active = Math.min(this.active, this.tabsList.length - 1);
    this.emit();
    return Promise.resolve();
  }

  async back(): Promise<ActionResult> {
    const tab = this.tab;
    const before = this.info(tab).url;
    if (tab.index > 0) tab.index -= 1;
    tab.refs = new Map();
    this.emit();
    return { tab: this.info(tab), navigated: this.info(tab).url !== before, blockedRequests: 0 };
  }

  stop(): Promise<void> {
    this.stopped += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.open_ = false;
    this.emit();
    return Promise.resolve();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
