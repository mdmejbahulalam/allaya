import type { NewTask, StepRecord, TaskEventRecord, TaskRecord, TaskStore } from '@allaya/agent';
import type { TaskEventRow, TaskRepository, TaskRow, TaskStepRow } from '@allaya/database';
import { newId } from '@allaya/shared';
import {
  RISK_LEVELS,
  STEP_STATES,
  TASK_COMPLEXITIES,
  TASK_EVENT_TYPES,
  TASK_SOURCES,
  TASK_STATES,
  type TaskEventType,
  type TaskState,
} from '@allaya/types';
import { z, serializedErrorSchema } from '@allaya/validation';

const MAX_EVENT_PAYLOAD = 4_000;

const stateSchema = z.enum(TASK_STATES);

const storedPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string().optional(),
      expected: z.string().optional(),
      toolHint: z.string().optional(),
      optional: z.boolean(),
      dependsOn: z.array(z.string()),
    }),
  ),
  successCriteria: z.string().optional(),
});

/** Engine bookkeeping that is never queried on, kept together in one column. */
const runtimeSchema = z.object({
  planFirst: z.boolean().default(false),
  usage: z
    .object({
      toolCalls: z.number().default(0),
      modelTurns: z.number().default(0),
      inputTokens: z.number().default(0),
      outputTokens: z.number().default(0),
      questions: z.number().default(0),
      elapsedMs: z.number().default(0),
    })
    .default({
      toolCalls: 0,
      modelTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      questions: 0,
      elapsedMs: 0,
    }),
  outcome: z.enum(['achieved', 'partial']).optional(),
  resumeState: stateSchema.optional(),
  pausedFrom: stateSchema.optional(),
  pauseReason: z.enum(['user', 'interrupted']).optional(),
  pending: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('plan_approval') }),
      z.object({ kind: z.literal('question'), question: z.string() }),
      z.object({
        kind: z.literal('declined'),
        tool: z.string(),
        summary: z.string(),
        unanswered: z.boolean().optional(),
      }),
    ])
    .optional(),
});

const stepDataSchema = z.object({
  planStepId: z.string().default(''),
  detail: z.string().optional(),
  expected: z.string().optional(),
  optional: z.boolean().default(false),
  dependsOn: z.array(z.string()).default([]),
  attempts: z.number().default(0),
  summary: z.string().optional(),
  evidence: z.string().optional(),
  unverified: z.boolean().default(false),
  retryNote: z.string().optional(),
});

function parseJson<T>(json: string | null, schema: z.ZodType<T>): T | undefined {
  if (!json) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T =>
  (list as readonly string[]).includes(value ?? '') ? (value as T) : fallback;

export function rowToTask(row: TaskRow): TaskRecord {
  const runtime = parseJson(row.runtimeJson, runtimeSchema) ?? runtimeSchema.parse({});
  const plan = parseJson(row.planJson, storedPlanSchema);
  const error = parseJson(row.errorJson, serializedErrorSchema);
  const complexity = TASK_COMPLEXITIES.find((c) => c === row.complexity);
  return {
    id: row.id,
    conversationId: row.conversationId ?? undefined,
    title: row.title,
    request: row.request,
    language: row.language === 'bn' ? 'bn' : 'en',
    state: oneOf(TASK_STATES, row.state, 'FAILED'),
    source: oneOf(TASK_SOURCES, row.source, 'chat'),
    complexity,
    planFirst: runtime.planFirst,
    automationRunId: row.automationRunId ?? undefined,
    riskLevel: oneOf(RISK_LEVELS, row.riskLevel, 'LOW'),
    plan,
    resultSummary: row.resultSummary ?? undefined,
    outcome: runtime.outcome,
    error,
    filesChanged: row.filesChanged,
    actionCount: row.actionCount,
    resumeState: runtime.resumeState,
    pausedFrom: runtime.pausedFrom,
    pauseReason: runtime.pauseReason,
    pending: runtime.pending,
    usage: runtime.usage,
    modelLabel: row.modelId ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function taskToRowPatch(
  task: TaskRecord,
): Partial<Omit<TaskRow, 'id' | 'createdAt' | 'updatedAt'>> {
  return {
    conversationId: task.conversationId ?? null,
    title: task.title,
    request: task.request,
    language: task.language,
    state: task.state,
    source: task.source,
    complexity: task.complexity ?? null,
    modelId: task.modelLabel ?? null,
    automationRunId: task.automationRunId ?? null,
    riskLevel: task.riskLevel,
    planJson: task.plan ? JSON.stringify(task.plan) : null,
    resultSummary: task.resultSummary ?? null,
    errorJson: task.error ? JSON.stringify(task.error) : null,
    runtimeJson: JSON.stringify({
      planFirst: task.planFirst,
      usage: task.usage,
      outcome: task.outcome,
      resumeState: task.resumeState,
      pausedFrom: task.pausedFrom,
      pauseReason: task.pauseReason,
      pending: task.pending,
    } satisfies z.input<typeof runtimeSchema>),
    filesChanged: task.filesChanged,
    actionCount: task.actionCount,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
  };
}

export function rowToStep(row: TaskStepRow): StepRecord {
  const data = parseJson(row.dataJson, stepDataSchema) ?? stepDataSchema.parse({});
  return {
    id: row.id,
    taskId: row.taskId,
    position: row.position,
    planStepId: data.planStepId || `s${row.position + 1}`,
    title: row.title,
    detail: data.detail,
    expected: data.expected,
    toolHint: row.toolName ?? undefined,
    optional: data.optional,
    dependsOn: data.dependsOn,
    state: oneOf(STEP_STATES, row.state, 'failed'),
    attempts: data.attempts,
    summary: data.summary,
    evidence: data.evidence,
    unverified: data.unverified,
    error: row.error ?? undefined,
    retryNote: data.retryNote,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
  };
}

function stepToRow(step: StepRecord): TaskStepRow {
  return {
    id: step.id,
    taskId: step.taskId,
    position: step.position,
    title: step.title,
    toolName: step.toolHint ?? null,
    state: step.state,
    error: step.error ?? null,
    dataJson: JSON.stringify({
      planStepId: step.planStepId,
      detail: step.detail,
      expected: step.expected,
      optional: step.optional,
      dependsOn: step.dependsOn,
      attempts: step.attempts,
      summary: step.summary,
      evidence: step.evidence,
      unverified: step.unverified,
      retryNote: step.retryNote,
    } satisfies z.input<typeof stepDataSchema>),
    startedAt: step.startedAt ?? null,
    completedAt: step.completedAt ?? null,
  };
}

export function rowToEvent(row: TaskEventRow): TaskEventRecord {
  let payload: Record<string, unknown> | undefined;
  if (row.payloadJson) {
    try {
      const parsed: unknown = JSON.parse(row.payloadJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = undefined;
    }
  }
  return {
    id: row.id,
    taskId: row.taskId,
    seq: row.seq,
    type: oneOf(TASK_EVENT_TYPES, row.type, 'STATE_CHANGED') satisfies TaskEventType,
    ...(payload ? { payload } : {}),
    createdAt: row.createdAt,
  };
}

/** The engine's `TaskStore`, on SQLite. Everything read back is validated: a damaged row degrades, never crashes. */
export class DbTaskStore implements TaskStore {
  constructor(private readonly repo: TaskRepository) {}

  create(input: NewTask): TaskRecord {
    this.repo.insert({
      id: input.id,
      conversationId: input.conversationId ?? null,
      title: input.title,
      request: input.request,
      language: input.language,
      source: input.source,
      complexity: input.complexity ?? null,
      automationRunId: input.automationRunId ?? null,
      runtimeJson: JSON.stringify({ planFirst: input.planFirst }),
    });
    return this.require(input.id);
  }

  get(id: string): TaskRecord | undefined {
    const row = this.repo.get(id);
    return row ? rowToTask(row) : undefined;
  }

  listByState(states: readonly TaskState[]): TaskRecord[] {
    return this.repo.listByState(states).map(rowToTask);
  }

  update(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'createdAt'>>): TaskRecord {
    const current = this.require(id);
    // An explicit `undefined` in the patch clears the field.
    this.repo.update(id, taskToRowPatch({ ...current, ...patch }));
    return this.require(id);
  }

  steps(taskId: string): StepRecord[] {
    return this.repo.steps(taskId).map(rowToStep);
  }

  replaceSteps(taskId: string, steps: StepRecord[]): void {
    this.repo.replaceSteps(taskId, steps.map(stepToRow));
  }

  updateStep(id: string, patch: Partial<Omit<StepRecord, 'id' | 'taskId'>>): StepRecord {
    const row = this.repo.getStep(id);
    if (!row) throw new Error(`step ${id} not found`);
    const next = stepToRow({ ...rowToStep(row), ...patch });
    this.repo.updateStep(id, {
      position: next.position,
      title: next.title,
      toolName: next.toolName,
      state: next.state,
      error: next.error,
      dataJson: next.dataJson,
      startedAt: next.startedAt,
      completedAt: next.completedAt,
    });
    return rowToStep(this.repo.getStep(id)!);
  }

  appendEvent(
    taskId: string,
    type: TaskEventType,
    payload?: Record<string, unknown>,
  ): TaskEventRecord {
    let payloadJson = payload ? JSON.stringify(payload) : undefined;
    if (payloadJson && payloadJson.length > MAX_EVENT_PAYLOAD) {
      payloadJson = JSON.stringify({ truncated: true });
    }
    return rowToEvent(this.repo.appendEvent({ id: newId('evt'), taskId, type, payloadJson }));
  }

  events(taskId: string): TaskEventRecord[] {
    return this.repo.events(taskId).map(rowToEvent);
  }

  private require(id: string): TaskRecord {
    const task = this.get(id);
    if (!task) throw new Error(`task ${id} not found`);
    return task;
  }
}
