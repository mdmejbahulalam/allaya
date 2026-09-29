import { AllayaError } from '@allaya/shared';
import type { TaskEventType, TaskState } from '@allaya/types';
import type { NewTask, StepRecord, TaskEventRecord, TaskRecord, TaskStore } from './types';

/** An in-memory `TaskStore`: what the engine's tests run on, and a reference for the SQLite one. */
export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly stepsByTask = new Map<string, StepRecord[]>();
  private readonly eventsByTask = new Map<string, TaskEventRecord[]>();
  private sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  create(input: NewTask): TaskRecord {
    const at = this.now();
    const record: TaskRecord = {
      id: input.id,
      conversationId: input.conversationId,
      title: input.title,
      request: input.request,
      language: input.language,
      state: 'CREATED',
      source: input.source,
      complexity: input.complexity,
      planFirst: input.planFirst,
      automationRunId: input.automationRunId,
      riskLevel: 'LOW',
      filesChanged: 0,
      actionCount: 0,
      usage: {
        toolCalls: 0,
        modelTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        questions: 0,
        elapsedMs: 0,
      },
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.set(record.id, record);
    return structuredClone(record);
  }

  get(id: string): TaskRecord | undefined {
    const record = this.tasks.get(id);
    return record ? structuredClone(record) : undefined;
  }

  listByState(states: readonly TaskState[]): TaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => states.includes(task.state))
      .map((task) => structuredClone(task));
  }

  update(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'createdAt'>>): TaskRecord {
    const current = this.tasks.get(id);
    if (!current) throw new AllayaError('Task not found', { code: 'NOT_FOUND' });
    const next: TaskRecord = { ...current, ...patch, updatedAt: this.now() };
    // `undefined` in a patch means "clear it".
    for (const key of Object.keys(patch) as (keyof TaskRecord)[]) {
      if (patch[key as keyof typeof patch] === undefined) delete next[key as 'error'];
    }
    this.tasks.set(id, next);
    return structuredClone(next);
  }

  steps(taskId: string): StepRecord[] {
    return structuredClone(this.stepsByTask.get(taskId) ?? []);
  }

  replaceSteps(taskId: string, steps: StepRecord[]): void {
    this.stepsByTask.set(taskId, structuredClone(steps));
  }

  updateStep(id: string, patch: Partial<Omit<StepRecord, 'id' | 'taskId'>>): StepRecord {
    for (const steps of this.stepsByTask.values()) {
      const index = steps.findIndex((step) => step.id === id);
      if (index === -1) continue;
      const next: StepRecord = { ...steps[index]!, ...patch };
      for (const key of Object.keys(patch) as (keyof StepRecord)[]) {
        if (patch[key as keyof typeof patch] === undefined) delete next[key as 'error'];
      }
      steps[index] = next;
      return structuredClone(next);
    }
    throw new AllayaError('Step not found', { code: 'NOT_FOUND' });
  }

  appendEvent(
    taskId: string,
    type: TaskEventType,
    payload?: Record<string, unknown>,
  ): TaskEventRecord {
    this.sequence += 1;
    const list = this.eventsByTask.get(taskId) ?? [];
    const event: TaskEventRecord = {
      id: `evt_${this.sequence}`,
      taskId,
      seq: list.length + 1,
      type,
      ...(payload ? { payload } : {}),
      createdAt: this.now(),
    };
    list.push(event);
    this.eventsByTask.set(taskId, list);
    return structuredClone(event);
  }

  events(taskId: string): TaskEventRecord[] {
    return structuredClone(this.eventsByTask.get(taskId) ?? []);
  }
}
