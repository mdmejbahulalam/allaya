import { AllayaError } from '@allaya/shared';
import {
  findInjection,
  sensitiveKind,
  tidyText,
  type ElementInfo,
  type PageSnapshot,
  type SensitiveKind,
} from './page-model';
import type { ActionResult, BrowserSession, NavigationResult, TabInfo } from './session';
import { type UrlPolicy, type ParsedUrl } from './url-policy';

export const MAX_TABS = 8;
export const MAX_TYPED_CHARS = 2000;
const REF = /^e(\d{1,6})_(\d{1,4})$/;

/** Keys the model may press. `Enter` can submit a form, so the tool grades it accordingly. */
export const ALLOWED_KEYS = [
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'Space',
] as const;

export const refuse = (
  message: string,
  reason: string,
  code: AllayaError['code'] = 'PERMISSION_DENIED',
) => new AllayaError(message, { code, details: { reason } });

export interface BrowserEngineOptions {
  session: BrowserSession | (() => Promise<BrowserSession>);
  policy: UrlPolicy;
  /** Actions allowed per window; a loop that clicks endlessly is stopped. */
  rate?: { max: number; windowMs: number };
  now?: () => number;
}

interface Held {
  generation: number;
  tabId: string;
  url: string;
  byRef: Map<string, ElementInfo>;
}

/**
 * The browser rules, independent of which browser is behind them. It checks every address (before and after
 * redirects), refuses to type into fields that receive secrets, refuses controls the model has not just seen,
 * caps tabs, and rate-limits actions. Everything the model learns about a page comes through `read`, which marks
 * it as untrusted and flags text that looks like instructions.
 */
export class BrowserEngine {
  private session: BrowserSession | undefined;
  private starting: Promise<BrowserSession> | undefined;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private held: Held | undefined;
  private typedInto: ElementInfo | undefined;
  private readonly sessionTrusted = new Set<string>();
  private readonly actionTimes: number[] = [];
  private readonly now: () => number;

  constructor(private readonly options: BrowserEngineOptions) {
    this.now = options.now ?? Date.now;
    if (typeof options.session !== 'function') this.adopt(options.session);
  }

  private adopt(session: BrowserSession): BrowserSession {
    this.session = session;
    session.onChange(() => this.changed());
    return session;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  get policy(): UrlPolicy {
    return this.options.policy;
  }

  isOpen(): boolean {
    return this.session?.isOpen() ?? false;
  }

  /** Domains the user approved to visit during this session are not asked about again. */
  trustHost(host: string): void {
    this.sessionTrusted.add(host);
  }

  isTrusted(host: string): boolean {
    return this.sessionTrusted.has(host) || this.options.policy.isTrusted(host);
  }

  private async ensure(): Promise<BrowserSession> {
    if (this.session?.isOpen()) return this.session;
    const factory = this.options.session;
    if (typeof factory !== 'function') {
      if (this.session) return this.session; // a fixed session (tests) that has been closed stays as it is
      throw refuse('The browser is not available', 'unavailable', 'UNSUPPORTED_PLATFORM');
    }
    this.starting ??= factory().finally(() => {
      this.starting = undefined;
    });
    return this.adopt(await this.starting);
  }

  private rateLimit(): void {
    const { max, windowMs } = this.options.rate ?? { max: 90, windowMs: 60_000 };
    const now = this.now();
    while (this.actionTimes.length > 0 && now - this.actionTimes[0]! > windowMs)
      this.actionTimes.shift();
    if (this.actionTimes.length >= max) {
      throw refuse(
        'Too many browser actions in a short time. Wait a moment.',
        'rate_limited',
        'TOOL_EXECUTION_FAILED',
      );
    }
    this.actionTimes.push(now);
  }

  private forget(): void {
    this.held = undefined;
    this.typedInto = undefined;
  }

  // ── navigation ──────────────────────────────────────────────────────────────────────────────────────────

  /** The address as it will be opened, or a refusal. Cheap and synchronous (no DNS): for grading a request. */
  preview(url: string): ParsedUrl {
    return this.options.policy.parse(url);
  }

  async open(
    url: string,
    options: { newTab?: boolean; signal?: AbortSignal | undefined } = {},
  ): Promise<NavigationResult> {
    const target = await this.options.policy.check(url);
    this.rateLimit();
    const session = await this.ensure();
    const tabs = await session.tabs();
    if (options.newTab && tabs.length >= MAX_TABS) {
      throw refuse(
        `There are already ${MAX_TABS} tabs open. Close one first.`,
        'too_many_tabs',
        'CONFLICT',
      );
    }
    this.forget();
    const result = await session.open(target.href, {
      newTab: options.newTab ?? false,
      signal: options.signal,
    });
    // Defence in depth: whatever the session followed, the address it ended on must be one we would have opened.
    if (!result.blocked && result.tab.url && result.tab.url !== 'about:blank') {
      const verdict = await this.options.policy.checkRequest(result.tab.url);
      if (verdict) {
        await session.open('about:blank', { newTab: false }).catch(() => undefined);
        throw refuse('The site sent the browser somewhere that is not allowed', verdict);
      }
    }
    if (!result.blocked) this.sessionTrusted.add(target.host);
    return result;
  }

  async back(signal?: AbortSignal): Promise<ActionResult> {
    this.rateLimit();
    const result = await (await this.ensure()).back(signal);
    this.forget();
    return result;
  }

  // ── reading ─────────────────────────────────────────────────────────────────────────────────────────────

  async read(
    options: { maxChars?: number; maxElements?: number } = {},
  ): Promise<PageSnapshot & { tabId: string }> {
    this.rateLimit();
    const session = await this.ensure();
    const generation = ++this.generation;
    const raw = await session.snapshot({
      generation,
      maxChars: Math.min(options.maxChars ?? 8000, 40_000),
      maxElements: Math.min(options.maxElements ?? 60, 150),
    });
    const tabs = await session.tabs();
    const tabId = tabs.find((tab) => tab.active)?.id ?? '';
    const { text, truncated } = tidyText(raw.text, Math.min(options.maxChars ?? 8000, 40_000));
    const elements = raw.elements.map((element) => {
      // The model is never shown what is typed into a field that holds a secret.
      const secret = sensitiveKind(element);
      return secret ? { ...element, value: undefined } : element;
    });
    this.held = {
      generation,
      tabId,
      url: raw.url,
      byRef: new Map(elements.map((e) => [e.ref, e])),
    };
    return {
      url: raw.url,
      title: raw.title,
      text,
      truncated,
      elements,
      elementsTruncated: raw.elementsTruncated,
      suspiciousText: findInjection(`${raw.title}\n${raw.text}`),
      generation,
      tabId,
    };
  }

  /** The field the model last typed into on this page (Enter would act on it). */
  focused(): ElementInfo | undefined {
    return this.typedInto;
  }

  /** The element behind a ref from the latest read, or `undefined` (never throws): used to grade risk. */
  peek(ref: string): ElementInfo | undefined {
    return this.held?.byRef.get(ref);
  }

  private resolve(ref: string): ElementInfo {
    const match = REF.exec(ref);
    if (!match)
      throw refuse(
        'That is not an element reference from the page. Read the page to get them.',
        'bad_ref',
        'INVALID_INPUT',
      );
    if (!this.held || this.held.generation !== Number(match[1])) {
      throw refuse(
        'The page has changed since it was read. Read it again to get fresh references.',
        'stale_ref',
        'CONFLICT',
      );
    }
    const element = this.held.byRef.get(ref);
    if (!element)
      throw refuse('That element is not on the page that was read.', 'bad_ref', 'NOT_FOUND');
    return element;
  }

  // ── acting ──────────────────────────────────────────────────────────────────────────────────────────────

  async click(ref: string, signal?: AbortSignal): Promise<ActionResult & { element: ElementInfo }> {
    const element = this.resolve(ref);
    if (element.disabled) throw refuse(`“${element.name}” is disabled`, 'disabled', 'CONFLICT');
    this.rateLimit();
    const result = await (await this.ensure()).click(ref, signal);
    if (result.navigated || result.newTab) this.forget();
    if (result.newTab) await this.checkTabUrl(result.newTab);
    return { ...result, element };
  }

  private async checkTabUrl(tab: TabInfo): Promise<void> {
    if (!tab.url || tab.url === 'about:blank') return;
    const verdict = await this.options.policy.checkRequest(tab.url);
    if (verdict) {
      const session = await this.ensure();
      await session.closeTab(tab.id).catch(() => undefined);
      throw refuse('The page opened a window that is not allowed', verdict);
    }
  }

  async type(
    ref: string,
    text: string,
    options: { submit?: boolean; signal?: AbortSignal | undefined } = {},
  ): Promise<{
    element: ElementInfo;
    typedCharacters: number;
    value: string | undefined;
    matches: boolean | undefined;
    submitted?: ActionResult;
  }> {
    const element = this.resolve(ref);
    const secret: SensitiveKind | undefined = sensitiveKind(element);
    if (secret) {
      throw refuse(
        `“${element.name}” asks for a ${secret === 'one_time_code' ? 'verification code' : secret === 'identity' ? 'identity number' : secret === 'payment' ? 'card detail' : 'password'}. Allaya does not type those: ask the user to enter it themselves in the browser window.`,
        'sensitive_field',
      );
    }
    if (!['textbox', 'searchbox', 'combobox'].includes(element.role)) {
      throw refuse(`“${element.name}” is not a place to type`, 'not_editable', 'INVALID_INPUT');
    }
    if (element.disabled) throw refuse(`“${element.name}” is disabled`, 'disabled', 'CONFLICT');
    if (text.length > MAX_TYPED_CHARS)
      throw refuse(
        `That text is too long to type (limit ${MAX_TYPED_CHARS})`,
        'too_long',
        'INVALID_INPUT',
      );
    this.rateLimit();
    const session = await this.ensure();
    const { value } = await session.fill(ref, text);
    this.typedInto = element;
    const matches = value === undefined ? undefined : value === text;
    let submitted: ActionResult | undefined;
    if (options.submit) {
      submitted = await session.press('Enter', options.signal);
      if (submitted.navigated || submitted.newTab) this.forget();
      if (submitted.newTab) await this.checkTabUrl(submitted.newTab);
    }
    return {
      element,
      typedCharacters: text.length,
      value,
      matches,
      ...(submitted ? { submitted } : {}),
    };
  }

  async press(key: string, signal?: AbortSignal): Promise<ActionResult> {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw refuse(
        `That key cannot be pressed. Allowed: ${ALLOWED_KEYS.join(', ')}`,
        'key_not_allowed',
        'INVALID_INPUT',
      );
    }
    this.rateLimit();
    const result = await (await this.ensure()).press(key, signal);
    if (result.navigated || result.newTab) this.forget();
    if (result.newTab) await this.checkTabUrl(result.newTab);
    return result;
  }

  async screenshot(): Promise<Uint8Array> {
    this.rateLimit();
    return (await this.ensure()).screenshot();
  }

  async tabs(): Promise<TabInfo[]> {
    return this.session?.isOpen() ? this.session.tabs() : [];
  }

  async switchTab(id: string): Promise<TabInfo> {
    this.rateLimit();
    const tab = await (await this.ensure()).switchTab(id);
    this.forget();
    return tab;
  }

  async closeTab(id: string): Promise<void> {
    this.rateLimit();
    await (await this.ensure()).closeTab(id);
    this.forget();
  }

  /** Starts the browser without going anywhere (so the person can sign in to a site themselves). */
  async ensureStarted(): Promise<void> {
    await this.ensure();
  }

  /** The emergency stop: stop loading; never throws. */
  async stop(): Promise<void> {
    await this.session?.stop().catch(() => undefined);
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.forget();
    await session?.close().catch(() => undefined);
    this.changed();
  }

  /** Fires when tabs open, close or navigate, or the browser closes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
