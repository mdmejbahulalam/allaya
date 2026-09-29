import type {
  AutomationRecord,
  AutomationStore,
  RunNote,
  RunRecord,
  RunTrigger,
} from '@allaya/automation';
import type { AutomationRepository, AutomationRow, AutomationRunRow } from '@allaya/database';
import { AUTOMATION_RUN_STATUSES } from '@allaya/types';
import {
  automationOptionsSchema,
  automationTriggerSchema,
  z,
  type AutomationTrigger,
} from '@allaya/validation';

/** Bookkeeping that is never queried on, kept in one column and validated on the way out. */
const stateSchema = z.object({
  seen: z.array(z.string()).optional(),
  problem: z.enum(['cannot_watch', 'too_many_failures']).optional(),
  consecutiveFailures: z.number().int().nonnegative().default(0),
});

const NOTES = [
  'missed',
  'still_running',
  'failed_to_start',
  'partial',
  'needs_you',
  'paused',
] as const;
const TRIGGERS = ['schedule', 'manual', 'event'] as const;

function parse<T>(json: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A trigger that no longer validates (a damaged row) becomes "manual": it can never fire by itself. */
const MANUAL: AutomationTrigger = { kind: 'manual' };

export function rowToAutomation(row: AutomationRow): AutomationRecord {
  const trigger = parse(row.triggerJson, automationTriggerSchema);
  const options =
    parse(row.optionsJson, automationOptionsSchema) ?? automationOptionsSchema.parse({});
  const state = parse(row.stateJson, stateSchema) ?? stateSchema.parse({});
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    instruction: row.instruction,
    // Without a readable trigger it must not run by itself, whatever the flag says.
    enabled: trigger ? row.enabled : false,
    trigger: trigger ?? MANUAL,
    options,
    nextRunAt: trigger ? (row.nextRunAt ?? undefined) : undefined,
    lastRunAt: row.lastRunAt ?? undefined,
    consecutiveFailures: state.consecutiveFailures,
    seen: state.seen,
    problem: state.problem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRow(record: AutomationRecord): AutomationRow {
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? null,
    instruction: record.instruction,
    enabled: record.enabled,
    triggerType:
      record.trigger.kind === 'manual'
        ? 'manual'
        : record.trigger.kind === 'new_file'
          ? 'event'
          : 'schedule',
    triggerJson: JSON.stringify(record.trigger),
    optionsJson: JSON.stringify(record.options),
    stateJson: JSON.stringify({
      seen: record.seen,
      problem: record.problem,
      consecutiveFailures: record.consecutiveFailures,
    } satisfies z.input<typeof stateSchema>),
    nextRunAt: record.nextRunAt ?? null,
    lastRunAt: record.lastRunAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function rowToRun(row: AutomationRunRow): RunRecord {
  return {
    id: row.id,
    automationId: row.automationId,
    status: (AUTOMATION_RUN_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as RunRecord['status'])
      : 'failed',
    triggeredBy: (TRIGGERS as readonly string[]).includes(row.triggeredBy)
      ? (row.triggeredBy as RunTrigger)
      : 'manual',
    taskId: row.taskId ?? undefined,
    note: (NOTES as readonly string[]).includes(row.note ?? '') ? (row.note as RunNote) : undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

const runToRow = (run: RunRecord): AutomationRunRow => ({
  id: run.id,
  automationId: run.automationId,
  status: run.status,
  triggeredBy: run.triggeredBy,
  note: run.note ?? null,
  taskId: run.taskId ?? null,
  error: run.error ?? null,
  startedAt: run.startedAt,
  completedAt: run.completedAt ?? null,
});

/** The scheduler's `AutomationStore`, on SQLite. */
export class DbAutomationStore implements AutomationStore {
  constructor(private readonly repo: AutomationRepository) {}

  list(): AutomationRecord[] {
    return this.repo.list().map(rowToAutomation);
  }

  get(id: string): AutomationRecord | undefined {
    const row = this.repo.get(id);
    return row ? rowToAutomation(row) : undefined;
  }

  insert(record: AutomationRecord): void {
    this.repo.insert(toRow(record));
  }

  update(id: string, patch: Partial<Omit<AutomationRecord, 'id' | 'createdAt'>>): AutomationRecord {
    const current = this.get(id);
    if (!current) throw new Error(`automation ${id} not found`);
    // An explicit `undefined` in the patch clears the field.
    const next = toRow({ ...current, ...patch });
    this.repo.update(id, {
      name: next.name,
      description: next.description,
      instruction: next.instruction,
      enabled: next.enabled,
      triggerType: next.triggerType,
      triggerJson: next.triggerJson,
      optionsJson: next.optionsJson,
      stateJson: next.stateJson,
      nextRunAt: next.nextRunAt,
      lastRunAt: next.lastRunAt,
      updatedAt: next.updatedAt,
    });
    return this.get(id)!;
  }

  remove(id: string): void {
    this.repo.remove(id);
  }

  addRun(run: RunRecord): void {
    this.repo.insertRun(runToRow(run));
  }

  updateRun(id: string, patch: Partial<Omit<RunRecord, 'id' | 'automationId'>>): RunRecord {
    const row = this.repo.getRun(id);
    if (!row) throw new Error(`run ${id} not found`);
    const next = runToRow({ ...rowToRun(row), ...patch });
    this.repo.updateRun(id, {
      status: next.status,
      triggeredBy: next.triggeredBy,
      note: next.note,
      taskId: next.taskId,
      error: next.error,
      startedAt: next.startedAt,
      completedAt: next.completedAt,
    });
    return rowToRun(this.repo.getRun(id)!);
  }

  runs(automationId: string, limit: number): RunRecord[] {
    return this.repo.runs(automationId, limit).map(rowToRun);
  }

  unfinishedRuns(): RunRecord[] {
    return this.repo.unfinishedRuns().map(rowToRun);
  }

  runByTask(taskId: string): RunRecord | undefined {
    const row = this.repo.runByTask(taskId);
    return row ? rowToRun(row) : undefined;
  }

  trimRuns(automationId: string, keep: number): void {
    this.repo.trimRuns(automationId, keep);
  }
}
