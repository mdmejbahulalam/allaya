import { afterEach, describe, expect, it } from 'vitest';
import type { AutomationRecord, RunRecord } from '@allaya/automation';
import {
  AutomationRepository,
  TaskRepository,
  eq,
  openDatabase,
  schema,
  sourceMigrationsFolder,
} from '@allaya/database';
import { DbAutomationStore } from '@main/automation/db-store';

const handles: Array<{ close(): void }> = [];
afterEach(() => handles.splice(0).forEach((h) => h.close()));

function open() {
  const handle = openDatabase({ path: ':memory:', migrationsFolder: sourceMigrationsFolder() });
  handles.push(handle);
  const tasks = new TaskRepository(handle.db);
  /** A run points at the task it started, so the task has to exist. */
  const task = (id: string) =>
    tasks.insert({
      id,
      conversationId: null,
      title: id,
      request: id,
      language: 'en',
      source: 'automation',
      complexity: null,
    });
  return {
    handle,
    task,
    store: new DbAutomationStore(new AutomationRepository(handle.db)),
  };
}

const record = (over: Partial<AutomationRecord> = {}): AutomationRecord => ({
  id: 'auto_1',
  name: 'Morning check',
  instruction: 'List my Downloads folder',
  enabled: true,
  trigger: { kind: 'daily', time: '09:00', days: [1, 2, 3] },
  options: { missed: 'skip', planFirst: false },
  nextRunAt: 5000,
  consecutiveFailures: 0,
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run_1',
  automationId: 'auto_1',
  status: 'running',
  triggeredBy: 'schedule',
  startedAt: 2000,
  ...over,
});

describe('DbAutomationStore', () => {
  it('stores an automation and reads it back exactly', () => {
    const { store } = open();
    const full = record({
      description: 'Every morning',
      lastRunAt: 4000,
      consecutiveFailures: 2,
      problem: 'cannot_watch',
      seen: ['a.pdf', 'b.pdf'],
      trigger: { kind: 'new_file', folder: 'Downloads' },
      options: { missed: 'run_once', planFirst: true },
    });
    store.insert(full);
    expect(store.get('auto_1')).toEqual(full);
    expect(store.list()).toEqual([full]);
    expect(store.get('nope')).toBeUndefined();
  });

  it('files each trigger under the right type', () => {
    const { store, handle } = open();
    store.insert(record({ id: 'a', trigger: { kind: 'manual' } }));
    store.insert(record({ id: 'b', trigger: { kind: 'interval', everyMinutes: 10 } }));
    store.insert(record({ id: 'c', trigger: { kind: 'new_file', folder: 'Downloads' } }));
    const types = Object.fromEntries(
      handle.db
        .select()
        .from(schema.automations)
        .all()
        .map((row) => [row.id, row.triggerType]),
    );
    expect(types).toEqual({ a: 'manual', b: 'schedule', c: 'event' });
  });

  it('changes only what is patched, and clears what is patched to undefined', () => {
    const { store } = open();
    store.insert(record({ problem: 'cannot_watch', seen: ['x'], lastRunAt: 9 }));
    const changed = store.update('auto_1', {
      name: 'Renamed',
      nextRunAt: undefined,
      problem: undefined,
      updatedAt: 2000,
    });
    expect(changed).toMatchObject({
      name: 'Renamed',
      instruction: 'List my Downloads folder',
      seen: ['x'],
      lastRunAt: 9,
      updatedAt: 2000,
    });
    expect(changed.nextRunAt).toBeUndefined();
    expect(changed.problem).toBeUndefined();
    expect(() => store.update('missing', { name: 'x' })).toThrow(/not found/);
  });

  it('lists oldest first, so the screen keeps its order', () => {
    const { store } = open();
    store.insert(record({ id: 'b', createdAt: 2000 }));
    store.insert(record({ id: 'a', createdAt: 1000 }));
    store.insert(record({ id: 'c', createdAt: 3000 }));
    expect(store.list().map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps runs newest first, finds unfinished ones and the run behind a task, and updates them', () => {
    const { store, task } = open();
    store.insert(record());
    for (const id of ['task_2', 'task_3']) task(id);
    store.addRun(run({ id: 'r1', startedAt: 1, status: 'completed', completedAt: 2 }));
    store.addRun(run({ id: 'r2', startedAt: 3, taskId: 'task_2' }));
    store.addRun(
      run({
        id: 'r3',
        startedAt: 5,
        status: 'waiting_for_approval',
        taskId: 'task_3',
        note: 'needs_you',
      }),
    );
    expect(store.runs('auto_1', 10).map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    expect(store.runs('auto_1', 1).map((r) => r.id)).toEqual(['r3']);
    expect(
      store
        .unfinishedRuns()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['r2', 'r3']);
    expect(store.runByTask('task_2')?.id).toBe('r2');
    expect(store.runByTask('nope')).toBeUndefined();
    const done = store.updateRun('r3', {
      status: 'completed',
      note: undefined,
      completedAt: 9,
      error: 'x',
    });
    expect(done).toMatchObject({ status: 'completed', completedAt: 9, error: 'x' });
    expect(done.note).toBeUndefined();
    expect(() => store.updateRun('missing', { status: 'failed' })).toThrow(/not found/);
  });

  it('keeps only the newest runs when trimming, per automation', () => {
    const { store } = open();
    store.insert(record());
    store.insert(record({ id: 'auto_2' }));
    for (let i = 0; i < 12; i += 1) store.addRun(run({ id: `r${i}`, startedAt: i }));
    store.addRun(run({ id: 'other', automationId: 'auto_2', startedAt: 1 }));
    store.trimRuns('auto_1', 5);
    expect(store.runs('auto_1', 50).map((r) => r.id)).toEqual(['r11', 'r10', 'r9', 'r8', 'r7']);
    expect(store.runs('auto_2', 50)).toHaveLength(1);
    store.trimRuns('auto_1', 50); // nothing to cut
    expect(store.runs('auto_1', 50)).toHaveLength(5);
  });

  it('removing an automation removes its runs and leaves other automations alone', () => {
    const { store, handle } = open();
    store.insert(record());
    store.insert(record({ id: 'auto_2' }));
    store.addRun(run());
    store.addRun(run({ id: 'r_other', automationId: 'auto_2' }));
    store.remove('auto_1');
    expect(store.get('auto_1')).toBeUndefined();
    expect(
      handle.db
        .select()
        .from(schema.automationRuns)
        .all()
        .map((r) => r.id),
    ).toEqual(['r_other']);
  });

  it('a damaged row degrades safely: it can never run by itself', () => {
    const { store, handle } = open();
    store.insert(record());
    handle.db
      .update(schema.automations)
      .set({
        triggerJson: '{"kind":"cron","expression":"* * * * *"}',
        optionsJson: 'nope',
        stateJson: '[1,',
      })
      .where(eq(schema.automations.id, 'auto_1'))
      .run();
    const damaged = store.get('auto_1')!;
    expect(damaged.trigger).toEqual({ kind: 'manual' });
    expect(damaged.enabled).toBe(false);
    expect(damaged.nextRunAt).toBeUndefined();
    expect(damaged.options).toEqual({ missed: 'skip', planFirst: false });
    expect(damaged.consecutiveFailures).toBe(0);
    expect(damaged.seen).toBeUndefined();
  });

  it('a damaged run row shows as failed, never as still running', () => {
    const { store, handle } = open();
    store.insert(record());
    store.addRun(run());
    handle.db
      .update(schema.automationRuns)
      .set({ status: 'levitating', triggeredBy: 'telepathy', note: 'mystery' })
      .where(eq(schema.automationRuns.id, 'run_1'))
      .run();
    expect(store.runs('auto_1', 1)[0]).toMatchObject({ status: 'failed', triggeredBy: 'manual' });
    expect(store.runs('auto_1', 1)[0]!.note).toBeUndefined();
  });
});
