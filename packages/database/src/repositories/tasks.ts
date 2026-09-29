import { and, asc, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { taskEvents, taskSteps, tasks, toolCalls } from '../schema';

export interface TaskRow {
  id: string;
  conversationId: string | null;
  title: string;
  request: string;
  language: string | null;
  state: string;
  source: string;
  complexity: string | null;
  modelId: string | null;
  riskLevel: string;
  planJson: string | null;
  resultSummary: string | null;
  errorJson: string | null;
  runtimeJson: string | null;
  automationRunId: string | null;
  filesChanged: number;
  actionCount: number;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskStepRow {
  id: string;
  taskId: string;
  position: number;
  title: string;
  toolName: string | null;
  state: string;
  error: string | null;
  dataJson: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface TaskEventRow {
  id: string;
  taskId: string;
  seq: number;
  type: string;
  payloadJson: string | null;
  createdAt: number;
}

export type NewTaskRow = Pick<
  TaskRow,
  'id' | 'conversationId' | 'title' | 'request' | 'language' | 'source' | 'complexity'
> &
  Partial<Pick<TaskRow, 'runtimeJson' | 'automationRunId'>>;

const taskColumns = {
  id: tasks.id,
  conversationId: tasks.conversationId,
  title: tasks.title,
  request: tasks.request,
  language: tasks.language,
  state: tasks.state,
  source: tasks.source,
  complexity: tasks.complexity,
  modelId: tasks.modelId,
  riskLevel: tasks.riskLevel,
  planJson: tasks.planJson,
  resultSummary: tasks.resultSummary,
  errorJson: tasks.errorJson,
  runtimeJson: tasks.runtimeJson,
  automationRunId: tasks.automationRunId,
  filesChanged: tasks.filesChanged,
  actionCount: tasks.actionCount,
  startedAt: tasks.startedAt,
  completedAt: tasks.completedAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

const stepColumns = {
  id: taskSteps.id,
  taskId: taskSteps.taskId,
  position: taskSteps.position,
  title: taskSteps.title,
  toolName: taskSteps.toolName,
  state: taskSteps.state,
  error: taskSteps.error,
  dataJson: taskSteps.dataJson,
  startedAt: taskSteps.startedAt,
  completedAt: taskSteps.completedAt,
};

/** Raw persistence of tasks, their steps and their timeline. Meaning and validation live in the desktop app's adapter. */
export class TaskRepository {
  constructor(
    private readonly db: AllayaDb,
    private readonly now: () => number = Date.now,
  ) {}

  insert(row: NewTaskRow): TaskRow {
    const at = this.now();
    this.db
      .insert(tasks)
      .values({ ...row, createdAt: at, updatedAt: at })
      .run();
    return this.get(row.id)!;
  }

  get(id: string): TaskRow | undefined {
    return this.db
      .select(taskColumns)
      .from(tasks)
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
      .get();
  }

  update(id: string, patch: Partial<Omit<TaskRow, 'id' | 'createdAt' | 'updatedAt'>>): void {
    this.db
      .update(tasks)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(tasks.id, id))
      .run();
  }

  /** Newest first. */
  list(
    options: { limit?: number; states?: readonly string[]; conversationId?: string } = {},
  ): TaskRow[] {
    const conditions = [isNull(tasks.deletedAt)];
    if (options.states) conditions.push(inArray(tasks.state, [...options.states]));
    if (options.conversationId) conditions.push(eq(tasks.conversationId, options.conversationId));
    return this.db
      .select(taskColumns)
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(options.limit ?? 200)
      .all();
  }

  listByState(states: readonly string[]): TaskRow[] {
    if (states.length === 0) return [];
    return this.db
      .select(taskColumns)
      .from(tasks)
      .where(and(isNull(tasks.deletedAt), inArray(tasks.state, [...states])))
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .all();
  }

  /**
   * Removes a task and (by cascade) its steps and timeline. The audit trail of what was done on the computer is
   * NOT part of the task's history: its tool calls are detached from the task, never deleted with it.
   */
  remove(id: string): boolean {
    return this.db.transaction((tx) => {
      tx.update(toolCalls).set({ taskId: null }).where(eq(toolCalls.taskId, id)).run();
      return tx.delete(tasks).where(eq(tasks.id, id)).run().changes > 0;
    });
  }

  // ── steps ────────────────────────────────────────────────────────────────
  steps(taskId: string): TaskStepRow[] {
    return this.db
      .select(stepColumns)
      .from(taskSteps)
      .where(eq(taskSteps.taskId, taskId))
      .orderBy(asc(taskSteps.position))
      .all();
  }

  /** Swaps in a whole new list of steps in one transaction (a new plan replaces the old one). */
  replaceSteps(taskId: string, rows: TaskStepRow[]): void {
    this.db.transaction((tx) => {
      tx.delete(taskSteps).where(eq(taskSteps.taskId, taskId)).run();
      for (const row of rows) tx.insert(taskSteps).values(row).run();
    });
  }

  getStep(id: string): TaskStepRow | undefined {
    return this.db.select(stepColumns).from(taskSteps).where(eq(taskSteps.id, id)).get();
  }

  updateStep(id: string, patch: Partial<Omit<TaskStepRow, 'id' | 'taskId'>>): void {
    this.db.update(taskSteps).set(patch).where(eq(taskSteps.id, id)).run();
  }

  // ── timeline ─────────────────────────────────────────────────────────────
  appendEvent(input: {
    id: string;
    taskId: string;
    type: string;
    payloadJson?: string | undefined;
  }): TaskEventRow {
    return this.db.transaction((tx) => {
      const last = tx
        .select({ value: max(taskEvents.seq) })
        .from(taskEvents)
        .where(eq(taskEvents.taskId, input.taskId))
        .get();
      const seq = (last?.value ?? 0) + 1;
      const createdAt = this.now();
      tx.insert(taskEvents)
        .values({
          id: input.id,
          taskId: input.taskId,
          seq,
          type: input.type,
          payloadJson: input.payloadJson ?? null,
          createdAt,
        })
        .run();
      return {
        id: input.id,
        taskId: input.taskId,
        seq,
        type: input.type,
        payloadJson: input.payloadJson ?? null,
        createdAt,
      };
    });
  }

  events(taskId: string): TaskEventRow[] {
    return this.db
      .select({
        id: taskEvents.id,
        taskId: taskEvents.taskId,
        seq: taskEvents.seq,
        type: taskEvents.type,
        payloadJson: taskEvents.payloadJson,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(asc(taskEvents.seq))
      .all();
  }
}
