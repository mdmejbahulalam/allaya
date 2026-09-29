import { writeFile } from 'node:fs/promises';
import { checkDatabaseHealth, type DatabaseHandle } from '@allaya/database';
import type { ComputerEngine } from '@allaya/computer';
import { redact, redactString } from '@allaya/shared';
import { DEFAULT_PERMISSION_MODES } from '@allaya/tools';
import type {
  AppInfo,
  Diagnostics,
  EmergencyStopStatus,
  ShellStatus,
  UpdateStatus,
} from '@allaya/validation';
import type { AutomationService } from './automation-service';
import type { BrowserService } from './browser-service';
import type { PermissionService } from './permission-service';
import type { ProviderService } from './provider-service';
import type { SettingsService } from './settings-service';
import type { MemoryManager } from '@allaya/memory';

export interface DiagnosticsDeps {
  appInfo: () => AppInfo;
  database: DatabaseHandle;
  providers: ProviderService;
  settings: SettingsService;
  permissions: PermissionService;
  automations: AutomationService;
  memory: MemoryManager;
  browser: BrowserService;
  engine: ComputerEngine;
  updates: () => UpdateStatus;
  shell: () => ShellStatus;
  emergencyStop: () => EmergencyStopStatus;
  /** The last lines of today's log (already JSON lines). Absent where there is no log file. */
  readLogTail?: (lines: number) => Promise<string[]>;
  logsFolder?: string;
  /** The person's home folder, removed from the exported text (it holds their user name). */
  home?: string;
  /** Asks where to save the export (a system dialog). Absent: exporting is not offered. */
  pickSaveFile?: (title: string, defaultName: string) => Promise<string | undefined>;
  now?: () => number;
}

const LOG_LINES_IN_EXPORT = 300;

/** Replaces the person's home folder with `~` and masks anything that looks like a credential. */
export function scrub(text: string, home: string | undefined): string {
  let out = redactString(text);
  if (home && home.length > 3) {
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
    for (const variant of variants) out = out.split(variant).join('~');
  }
  return out;
}

/**
 * The Diagnostics page: a picture of Allaya's own health, and an export that can be sent to someone who is helping.
 * It reports statuses and counts. It never reads chat, memories, tasks or files, and the export passes every string
 * through secret redaction and removes the person's home folder.
 */
export class DiagnosticsService {
  constructor(private readonly deps: DiagnosticsDeps) {}

  async get(): Promise<Diagnostics> {
    const { deps } = this;
    const info = deps.appInfo();
    const health = checkDatabaseHealth(deps.database);
    const providers = deps.providers.list();
    const connected = providers.filter((p) => p.status === 'connected').length;
    const caps = deps.engine.capabilities();
    const browser = await deps.browser.status();
    const automations = deps.automations.overview();
    const changed = deps.permissions
      .list()
      .filter((p) => p.mode !== DEFAULT_PERMISSION_MODES[p.subject])
      .map((p) => ({ subject: p.subject, mode: p.mode }));
    const shell = deps.shell();
    const stop = deps.emergencyStop();
    const updates = deps.updates();
    const voiceEnabled = deps.settings.get('voice.enabled');
    const cloudSpeechReady = connected > 0;

    return {
      generatedAt: (deps.now ?? Date.now)(),
      app: {
        name: info.name,
        version: info.version,
        electron: info.electronVersion,
        chrome: info.chromeVersion,
        node: info.nodeVersion,
        platform: info.platform,
        osVersion: info.osVersion,
        arch: info.arch,
        packaged: info.isPackaged,
        environment: info.environment,
      },
      database: {
        tone: health.ok ? 'ok' : 'attention',
        ok: health.ok,
        migrations: health.schemaVersion,
        tables: health.tableCount,
        journalMode: health.journalMode,
        foreignKeys: health.foreignKeys,
        ...(health.error ? { error: health.error } : {}),
      },
      providers: {
        tone: connected > 0 ? 'ok' : 'attention',
        connected,
        total: providers.length,
        items: providers.map((p) => ({
          name: p.name,
          status: p.status,
          models: p.models.length,
          ...(p.errorCode ? { errorCode: p.errorCode } : {}),
        })),
      },
      voice: {
        tone: voiceEnabled ? 'ok' : 'off',
        enabled: voiceEnabled,
        speechEngine: deps.settings.get('voice.speechEngine'),
        inputLanguage: deps.settings.get('voice.inputLanguage'),
        cloudSpeechReady,
      },
      computer: {
        tone: caps.launch || caps.windows ? 'ok' : 'attention',
        adapter: deps.engine.name,
        platform: deps.engine.platform,
        capabilities: { ...caps },
      },
      browser: {
        tone: browser.available ? 'ok' : 'attention',
        available: browser.available,
        engine: browser.engine,
        running: browser.running,
      },
      automations: {
        tone: automations.paused ? 'attention' : 'ok',
        total: automations.automations.length,
        enabled: automations.automations.filter((a) => a.enabled).length,
        paused: automations.paused,
      },
      memory: {
        tone: deps.memory.enabled ? 'ok' : 'off',
        enabled: deps.memory.enabled,
        count: deps.memory.overview().memories.length,
      },
      permissions: { tone: 'ok', changed },
      shell: {
        tone: stop.registered ? 'ok' : 'attention',
        trayAvailable: shell.trayAvailable,
        launchAtLoginSupported: shell.launchAtLoginSupported,
        emergencyStop: stop,
        showAppKey: shell.showAppKey,
      },
      updates: {
        tone:
          updates.state === 'error' ? 'attention' : updates.state === 'unsupported' ? 'off' : 'ok',
        state: updates.state,
      },
      logs: { ...(deps.logsFolder ? { folder: deps.logsFolder } : {}) },
    };
  }

  /** The text that is saved: the report and recent log lines, scrubbed. Also what tests check for leaks. */
  async exportText(): Promise<string> {
    const report = await this.get();
    const lines = this.deps.readLogTail
      ? await this.deps.readLogTail(LOG_LINES_IN_EXPORT).catch(() => [])
      : [];
    const scrubbed = JSON.parse(scrub(JSON.stringify(redact(report)), this.deps.home)) as unknown;
    return JSON.stringify(
      {
        note:
          'Allaya diagnostics. Statuses and counts, and recent log lines with keys, tokens and your home folder removed. ' +
          'It contains no chat, memories, tasks or file contents. Look it over before you send it to anyone.',
        report: scrubbed,
        logTail: lines.map((line) => scrub(line, this.deps.home)),
      },
      null,
      2,
    );
  }

  /** Saves the export where the person chooses. `false` when they cancel or there is no dialog. */
  async export(): Promise<boolean> {
    const pick = this.deps.pickSaveFile;
    if (!pick) return false;
    const path = await pick('Save the Allaya diagnostics', 'allaya-diagnostics.json');
    if (!path) return false;
    await writeFile(path, await this.exportText(), { encoding: 'utf8', mode: 0o600 });
    return true;
  }
}
