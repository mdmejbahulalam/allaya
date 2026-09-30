import { and, asc, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { automationRuns, automations } from '../schema';

export interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  instruction: string;
  workflowJson: string | null;
  enabled: boolean;
  triggerType: string;
  triggerJson: string;
  optionsJson: string;
  stateJson: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationRunRow {
  id: string;
  automationId: string;
  status: string;
  triggeredBy: string;
  note: string | null;
  taskId: string | null;
  workflowStateJson: string | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

const automationColumns = {
  id: automations.id,
  name: automations.name,
  description: automations.description,
  instruction: automations.instruction,
  workflowJson: automations.workflowJson,
  enabled: automations.enabled,
  triggerType: automations.triggerType,
  triggerJson: automations.triggerJson,
  optionsJson: automations.optionsJson,
  stateJson: automations.stateJson,
  nextRunAt: automations.nextRunAt,
  lastRunAt: automations.lastRunAt,
  createdAt: automations.createdAt,
  updatedAt: automations.updatedAt,
};

const runColumns = {
  id: automationRuns.id,
  automationId: automationRuns.automationId,
  status: automationRuns.status,
  triggeredBy: automationRuns.triggeredBy,
  note: automationRuns.note,
  taskId: automationRuns.taskId,
  workflowStateJson: automationRuns.workflowStateJson,
  error: automationRuns.error,
  startedAt: automationRuns.startedAt,
  completedAt: automationRuns.completedAt,
};

const UNFINISHED = ['running', 'waiting_for_approval'];

/** Raw persistence of automations and their runs. Meaning and validation live in the desktop app's adapter. */
export class AutomationRepository {
  constructor(private readonly db: AllayaDb) {}

  insert(row: AutomationRow): void {
    this.db.insert(automations).values(row).run();
  }

  get(id: string): AutomationRow | undefined {
    return this.db
      .select(automationColumns)
      .from(automations)
      .where(and(eq(automations.id, id), isNull(automations.deletedAt)))
      .get();
  }

  /** Oldest first, so the list keeps its order as things are added. */
  list(): AutomationRow[] {
    return this.db
      .select(automationColumns)
      .from(automations)
      .where(isNull(automations.deletedAt))
      .orderBy(asc(automations.createdAt), asc(automations.id))
      .all();
  }

  update(id: string, patch: Partial<Omit<AutomationRow, 'id' | 'createdAt'>>): void {
    this.db.update(automations).set(patch).where(eq(automations.id, id)).run();
  }

  /** Removes an automation and (by cascade) its runs. Tasks it started stay, detached, in the task list. */
  remove(id: string): void {
    this.db.delete(automations).where(eq(automations.id, id)).run();
  }

  // ── runs ─────────────────────────────────────────────────────────────────
  insertRun(row: AutomationRunRow): void {
    this.db.insert(automationRuns).values(row).run();
  }

  getRun(id: string): AutomationRunRow | undefined {
    return this.db.select(runColumns).from(automationRuns).where(eq(automationRuns.id, id)).get();
  }

  updateRun(id: string, patch: Partial<Omit<AutomationRunRow, 'id' | 'automationId'>>): void {
    this.db.update(automationRuns).set(patch).where(eq(automationRuns.id, id)).run();
  }

  /** Newest first. */
  runs(automationId: string, limit: number): AutomationRunRow[] {
    return this.db
      .select(runColumns)
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
      .limit(limit)
      .all();
  }

  unfinishedRuns(): AutomationRunRow[] {
    return this.db
      .select(runColumns)
      .from(automationRuns)
      .where(inArray(automationRuns.status, UNFINISHED))
      .all();
  }

  runByTask(taskId: string): AutomationRunRow | undefined {
    return this.db
      .select(runColumns)
      .from(automationRuns)
      .where(eq(automationRuns.taskId, taskId))
      .get();
  }

  /** Keeps only the newest `keep` runs of an automation. */
  trimRuns(automationId: string, keep: number): void {
    const newest = this.runs(automationId, keep).map((row) => row.id);
    if (newest.length < keep) return;
    this.db
      .delete(automationRuns)
      .where(
        and(eq(automationRuns.automationId, automationId), notInArray(automationRuns.id, newest)),
      )
      .run();
  }
}
