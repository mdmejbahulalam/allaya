import { AllayaError } from '@allaya/shared';
import type { AutomationRecord, AutomationStore, RunRecord } from './scheduler';

/** An in-memory `AutomationStore`: what the scheduler's tests run on, and a reference for the SQLite one. */
export class MemoryAutomationStore implements AutomationStore {
  private readonly automations = new Map<string, AutomationRecord>();
  private runsList: RunRecord[] = [];

  list(): AutomationRecord[] {
    return [...this.automations.values()].map((a) => structuredClone(a));
  }

  get(id: string): AutomationRecord | undefined {
    const found = this.automations.get(id);
    return found ? structuredClone(found) : undefined;
  }

  insert(record: AutomationRecord): void {
    this.automations.set(record.id, structuredClone(record));
  }

  update(id: string, patch: Partial<Omit<AutomationRecord, 'id' | 'createdAt'>>): AutomationRecord {
    const current = this.automations.get(id);
    if (!current) throw new AllayaError('Automation not found', { code: 'NOT_FOUND' });
    const next = { ...current, ...patch };
    // `undefined` in a patch means "clear it".
    for (const key of Object.keys(patch) as (keyof AutomationRecord)[]) {
      if (patch[key as keyof typeof patch] === undefined) delete next[key as 'problem'];
    }
    this.automations.set(id, next);
    return structuredClone(next);
  }

  remove(id: string): void {
    this.automations.delete(id);
    this.runsList = this.runsList.filter((run) => run.automationId !== id);
  }

  addRun(run: RunRecord): void {
    this.runsList.push(structuredClone(run));
  }

  updateRun(id: string, patch: Partial<Omit<RunRecord, 'id' | 'automationId'>>): RunRecord {
    const index = this.runsList.findIndex((run) => run.id === id);
    if (index === -1) throw new AllayaError('Run not found', { code: 'NOT_FOUND' });
    const next = { ...this.runsList[index]!, ...patch };
    for (const key of Object.keys(patch) as (keyof RunRecord)[]) {
      if (patch[key as keyof typeof patch] === undefined) delete next[key as 'note'];
    }
    this.runsList[index] = next;
    return structuredClone(next);
  }

  runs(automationId: string, limit: number): RunRecord[] {
    return this.runsList
      .filter((run) => run.automationId === automationId)
      .map((run, order) => ({ run, order }))
      .sort((a, b) => b.run.startedAt - a.run.startedAt || b.order - a.order)
      .slice(0, limit)
      .map(({ run }) => structuredClone(run));
  }

  unfinishedRuns(): RunRecord[] {
    return this.runsList
      .filter((run) => run.status === 'running' || run.status === 'waiting_for_approval')
      .map((run) => structuredClone(run));
  }

  runByTask(taskId: string): RunRecord | undefined {
    const found = this.runsList.find((run) => run.taskId === taskId);
    return found ? structuredClone(found) : undefined;
  }

  trimRuns(automationId: string, keep: number): void {
    const mine = this.runs(automationId, Number.MAX_SAFE_INTEGER);
    const drop = new Set(mine.slice(keep).map((run) => run.id));
    this.runsList = this.runsList.filter((run) => !drop.has(run.id));
  }
}
