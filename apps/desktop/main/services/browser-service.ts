import { redactUrl, normalizeDomain, type BrowserEngine, type BrowserKind } from '@allaya/browser';
import type { Logger } from '@allaya/shared';
import type { ToolDefinition } from '@allaya/tools';
import type { BrowserStatus } from '@allaya/validation';
import type { SettingsService } from './settings-service';

/** State shared with the code that starts the browser, so the service can ask for a visible window. */
export interface BrowserLaunchState {
  /** The next launch must be a visible window, whatever `browser.headless` says. */
  forceHeaded: boolean;
  /** How the running browser was started. */
  headless: boolean;
}

export interface BrowserServiceDeps {
  engine: BrowserEngine;
  settings: SettingsService;
  /** Which browser will be used, or `undefined` when none is installed. */
  engineKind: () => BrowserKind | undefined;
  tools: readonly ToolDefinition[];
  launch: BrowserLaunchState;
  profileFolder: string;
  logger: Logger;
}

/** What the Browser screen shows and controls: which browser, what is open, which sites are trusted or blocked. */
export class BrowserService {
  constructor(private readonly deps: BrowserServiceDeps) {}

  async status(): Promise<BrowserStatus> {
    const { engine, settings, engineKind, tools, launch, profileFolder } = this.deps;
    const kind = engineKind() ?? null;
    const tabs = engine.isOpen() ? await engine.tabs().catch(() => []) : [];
    return {
      available: kind !== null,
      engine: kind,
      running: engine.isOpen(),
      headless: engine.isOpen() ? launch.headless : settings.get('browser.headless'),
      tabs: tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: redactUrl(tab.url),
        active: tab.active,
      })),
      trustedDomains: settings.get('browser.trustedDomains'),
      blockedDomains: settings.get('browser.blockedDomains'),
      profileFolder,
      tools: tools.map((tool) => ({
        name: tool.name,
        readOnly: tool.readOnly,
        risk: typeof tool.risk === 'function' ? 'varies' : tool.risk,
      })),
    };
  }

  /** Adds or removes a site. A site is on one list or the other, never both. */
  async setDomain(
    list: 'trusted' | 'blocked',
    input: string,
    present: boolean,
  ): Promise<BrowserStatus> {
    const { settings } = this.deps;
    const domain = normalizeDomain(input); // throws a clear refusal for anything that is not a domain
    const key = list === 'trusted' ? 'browser.trustedDomains' : 'browser.blockedDomains';
    const otherKey = list === 'trusted' ? 'browser.blockedDomains' : 'browser.trustedDomains';
    const current = settings.get(key);
    const without = current.filter((d) => d !== domain);
    settings.set({ key, value: present ? [...without, domain].sort() : without } as never);
    if (present) {
      const other = settings.get(otherKey);
      if (other.includes(domain)) {
        settings.set({ key: otherKey, value: other.filter((d) => d !== domain) } as never);
      }
    }
    return this.status();
  }

  /** Opens the browser window for the person (visible), optionally at an address. */
  async openWindow(url?: string): Promise<BrowserStatus> {
    const { engine, launch } = this.deps;
    if (engine.isOpen() && launch.headless) await engine.close(); // a hidden browser cannot be signed in to
    launch.forceHeaded = true;
    try {
      if (url) await engine.open(url);
      else await engine.ensureStarted();
    } finally {
      launch.forceHeaded = false;
    }
    return this.status();
  }

  async close(): Promise<BrowserStatus> {
    await this.deps.engine.close();
    return this.status();
  }
}
