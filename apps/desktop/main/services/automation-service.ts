import {
  AutomationScheduler,
  type AutomationRecord,
  type AutomationStore,
  type AutomationSummary,
  type RunLauncher,
  type RunRecord,
} from '@allaya/automation';
import { AllayaError, type Logger, type RunRegistry } from '@allaya/shared';
import type {
  AutomationInput,
  AutomationRunView,
  AutomationView,
  AutomationsOverview,
} from '@allaya/validation';
import { MAX_AUTOMATIONS } from '@allaya/validation';
import type { EventPublisher } from '../ipc/events';
import type { FileService } from './file-service';
import type { SettingsService } from './settings-service';
import type { TaskService } from './task-service';

export interface AutomationServiceDeps {
  store: AutomationStore;
  tasks: TaskService;
  files: FileService;
  settings: SettingsService;
  events: EventPublisher;
  runs: RunRegistry;
  logger: Logger;
  now?: () => number;
}

/**
 * Owns automations: the schedule, the run history, the screen's commands. Every run is an ordinary task started
 * through the task engine — same tools, same permissions, same confirmations — so an unattended run can never do
 * more than a conversation could, and one that needs the person simply waits for them.
 */
export class AutomationService {
  readonly scheduler: AutomationScheduler;
  private publishScheduled = false;

  constructor(private readonly deps: AutomationServiceDeps) {
    const launcher: RunLauncher = {
      launch: ({ automation, runId, request }) => {
        const task = deps.tasks.create({
          request,
          title: automation.name,
          source: 'automation',
          planFirst: automation.options.planFirst,
          automationRunId: runId,
        });
        return { taskId: task.id };
      },
      taskState: (taskId) => {
        const task = deps.tasks.snapshot(taskId);
        return task
          ? { state: task.state, outcome: task.outcome, error: task.error?.message }
          : undefined;
      },
    };
    this.scheduler = new AutomationScheduler({
      store: deps.store,
      launcher,
      folders: { names: (folder) => deps.files.names(folder) },
      logger: deps.logger,
      ...(deps.now ? { now: deps.now } : {}),
      paused: () => deps.settings.get('automations.paused'),
      onChange: () => this.scheduleChanged(),
    });
    // A task an automation started ends, needs the person, or goes on: the run follows it.
    deps.tasks.subscribe((task) => {
      if (task.source !== 'automation') return;
      this.scheduler.taskChanged(task.id, {
        state: task.state,
        outcome: task.outcome,
        error: task.error?.message,
      });
    });
    // The emergency stop (or a typed "stop") also stops schedules from starting things, until the person says so.
    // Closing the app is not a stop: nothing is paused for it.
    deps.runs.events.on('stopped', ({ reason }) => {
      if (reason === 'shutdown') return;
      if (deps.store.list().some((a) => a.enabled && a.trigger.kind !== 'manual')) {
        try {
          deps.settings.set({ key: 'automations.paused', value: true });
          this.scheduleChanged();
        } catch (error) {
          deps.logger.warn('Could not pause automations', { error: String(error) });
        }
      }
    });
  }

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  // ── queries ───────────────────────────────────────────────────────────────
  overview(): AutomationsOverview {
    return {
      automations: this.deps.store.list().map((record) => this.view(record)),
      paused: this.deps.settings.get('automations.paused'),
      limit: MAX_AUTOMATIONS,
    };
  }

  runs(id: string, limit = 30): AutomationRunView[] {
    this.require(id);
    return this.deps.store.runs(id, limit).map(toRunView);
  }

  // ── commands ──────────────────────────────────────────────────────────────
  async create(
    input: AutomationInput & { enabled?: boolean | undefined },
  ): Promise<AutomationView> {
    return this.view(await this.scheduler.create(input));
  }

  async update(id: string, input: AutomationInput): Promise<AutomationView> {
    return this.view(await this.scheduler.update(id, input));
  }

  setEnabled(id: string, enabled: boolean): AutomationView {
    return this.view(this.scheduler.setEnabled(id, enabled));
  }

  runNow(id: string): AutomationRunView {
    return toRunView(this.scheduler.runNow(id));
  }

  remove(id: string): void {
    this.scheduler.remove(id);
  }

  setPaused(paused: boolean): void {
    this.deps.settings.set({ key: 'automations.paused', value: paused });
    this.scheduleChanged();
  }

  // ── what the model's tools use ────────────────────────────────────────────
  async createForTool(input: AutomationInput): Promise<AutomationSummary> {
    return toSummary(await this.scheduler.create({ ...input, enabled: true }));
  }

  summary(id: string): AutomationSummary | undefined {
    const record = this.deps.store.get(id);
    return record ? toSummary(record) : undefined;
  }

  summaries(): AutomationSummary[] {
    return this.deps.store.list().map(toSummary);
  }

  // ── plumbing ──────────────────────────────────────────────────────────────
  private view(record: AutomationRecord): AutomationView {
    const last = this.deps.store.runs(record.id, 1)[0];
    return {
      id: record.id,
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
      instruction: record.instruction,
      enabled: record.enabled,
      trigger: record.trigger,
      options: record.options,
      ...(record.nextRunAt !== undefined ? { nextRunAt: record.nextRunAt } : {}),
      ...(record.lastRunAt !== undefined ? { lastRunAt: record.lastRunAt } : {}),
      ...(last ? { lastRun: toRunView(last) } : {}),
      consecutiveFailures: record.consecutiveFailures,
      ...(record.problem ? { problem: record.problem } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /** Several changes in one tick become one push. */
  private scheduleChanged(): void {
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    queueMicrotask(() => {
      this.publishScheduled = false;
      try {
        this.deps.events.publish('automations:changed', {});
      } catch (error) {
        this.deps.logger.warn('Could not publish an automation change', { error: String(error) });
      }
    });
  }

  private require(id: string): AutomationRecord {
    const record = this.deps.store.get(id);
    if (!record) throw new AllayaError('Automation not found', { code: 'NOT_FOUND' });
    return record;
  }
}

const toSummary = (record: AutomationRecord): AutomationSummary => ({
  id: record.id,
  name: record.name,
  enabled: record.enabled,
  trigger: record.trigger,
  instruction: record.instruction,
  nextRunAt: record.nextRunAt,
});

const toRunView = (run: RunRecord): AutomationRunView => ({
  id: run.id,
  status: run.status,
  triggeredBy: run.triggeredBy,
  ...(run.taskId ? { taskId: run.taskId } : {}),
  ...(run.note ? { note: run.note } : {}),
  ...(run.error ? { error: run.error } : {}),
  startedAt: run.startedAt,
  ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
});
