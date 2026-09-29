import { APP_CATALOG, resolveApp, type AppEntry, type ComputerEngine } from '@allaya/computer';
import type { ToolAuditRepository } from '@allaya/database';
import { newId, type Logger, type RunRegistry } from '@allaya/shared';
import type { AppOutcome, AppView, AppsOverview } from '@allaya/validation';
import type { ToolLanguage } from '@allaya/tools';
import type { SettingsService } from './settings-service';
import type { ToolService } from './tool-service';

export interface AppsServiceDeps {
  engine: ComputerEngine;
  tools: ToolService;
  audit: ToolAuditRepository;
  runs: RunRegistry;
  settings: SettingsService;
  osLocale: () => string;
  logger: Logger;
  now?: () => number;
}

/** Installed-app detection is a slow script on Windows; the answer is reused for this long. */
const INSTALLED_TTL_MS = 60_000;
const USAGE_TOOLS = ['open_app', 'close_app'] as const;

/**
 * The Applications screen. It lists the fixed catalog of apps Allaya knows, and what is true of each right now
 * (installed, running, last used, what Allaya can do with it here). Its buttons do not act directly: they run the
 * same tools the AI uses — so the person's permission settings, confirmations, verification and the activity record
 * all apply — and the emergency stop reaches them.
 */
export class AppsService {
  private installedCache: { at: number; value: Set<string> | undefined } | undefined;

  constructor(private readonly deps: AppsServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private language(): ToolLanguage {
    const preference = this.deps.settings.get('language.ui');
    if (preference === 'bn' || preference === 'en') return preference;
    return this.deps.osLocale().toLowerCase().startsWith('bn') ? 'bn' : 'en';
  }

  async list(): Promise<AppsOverview> {
    const { engine, audit } = this.deps;
    const caps = engine.capabilities();
    const installed = caps.launch ? await this.installed() : undefined;
    const running = caps.windows ? await this.runningProcesses() : undefined;
    const apps = APP_CATALOG.map((entry): AppView => {
      const lastUsedAt = audit.lastActivityAt(USAGE_TOOLS, entry.name);
      return {
        name: entry.name,
        installed: installed === undefined ? 'unknown' : installed.has(entry.name) ? 'yes' : 'no',
        running: running ? entry.processes.some((p) => running.has(p.toLowerCase())) : null,
        ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
        support: this.support(entry),
        risk: entry.risk,
      };
    });
    return { apps, can: { launch: caps.launch, windows: caps.windows }, platform: engine.platform };
  }

  open(name: string): Promise<AppOutcome> {
    return this.run('open_app', { app: this.known(name).name });
  }

  close(name: string): Promise<AppOutcome> {
    return this.run('close_app', { app: this.known(name).name });
  }

  async focus(name: string): Promise<AppOutcome> {
    const entry = this.known(name);
    const windows = await this.deps.engine.windowsOf(entry).catch(() => []);
    const target = windows[0];
    if (!target) {
      return {
        ok: false,
        status: 'failed',
        summary: `${entry.name} is not open`,
        message: `${entry.name} is not open`,
      };
    }
    return this.run('focus_window', { windowId: target.id });
  }

  /** Only names from the fixed catalog get this far: anything else is not an app Allaya can open. */
  private known(name: string): AppEntry {
    const entry = resolveApp(name);
    if (!entry) throw new Error('not an app Allaya knows');
    return entry;
  }

  private support(entry: AppEntry): AppView['support'] {
    const caps = this.deps.engine.capabilities();
    if (!caps.launch && !caps.windows) return 'none';
    if (entry.shell) return 'limited';
    return caps.uiAutomation && caps.keyboard && caps.mouse ? 'full' : 'basic';
  }

  private async installed(): Promise<Set<string> | undefined> {
    const cached = this.installedCache;
    if (cached && this.now() - cached.at < INSTALLED_TTL_MS) return cached.value;
    const value = await this.deps.engine.installedApps();
    this.installedCache = { at: this.now(), value };
    return value;
  }

  private async runningProcesses(): Promise<Set<string> | undefined> {
    try {
      const windows = await this.deps.engine.listWindows();
      return new Set(windows.map((w) => w.processName.toLowerCase()));
    } catch (error) {
      this.deps.logger.warn('Could not list windows for the Applications screen', {
        error: String(error),
      });
      return undefined;
    }
  }

  private async run(tool: string, args: unknown): Promise<AppOutcome> {
    const { runs, tools } = this.deps;
    const id = newId('call');
    const runId = `apps-${id}`;
    const source = runs.start(runId, 'apps'); // the emergency stop reaches this too
    try {
      const result = await tools.execute(
        { id, name: tool, arguments: args },
        { signal: source.signal, language: this.language() },
      );
      this.installedCache = undefined;
      return {
        ok: result.ok,
        status: result.status,
        summary: result.summary,
        ...(result.error ? { message: result.error.message } : {}),
      };
    } finally {
      runs.finish(runId);
    }
  }
}
