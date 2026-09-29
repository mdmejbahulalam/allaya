import { afterEach, describe, expect, it } from 'vitest';
import { TaskRepository, eq, openDatabase, schema, sourceMigrationsFolder } from '@allaya/database';
import type { StepRecord } from '@allaya/agent';
import { DbTaskStore } from '@main/tasks/db-store';

const handles: Array<{ close(): void }> = [];
afterEach(() => handles.splice(0).forEach((h) => h.close()));

function open() {
  const handle = openDatabase({ path: ':memory:', migrationsFolder: sourceMigrationsFolder() });
  handles.push(handle);
  let clock = 1_000;
  const repo = new TaskRepository(handle.db, () => (clock += 10));
  return { handle, repo, store: new DbTaskStore(repo) };
}

const newTask = (id = 'task_1') => ({
  id,
  title: 'Move the report',
  request: 'Move the report to Documents',
  language: 'en' as const,
  source: 'chat' as const,
  planFirst: true,
});

const step = (taskId: string, position: number, extra: Partial<StepRecord> = {}): StepRecord => ({
  id: `step_${taskId}_${position}`,
  taskId,
  position,
  planStepId: `s${position + 1}`,
  title: `Step ${position + 1}`,
  optional: false,
  dependsOn: [],
  state: 'pending',
  attempts: 0,
  unverified: false,
  ...extra,
});

describe('DbTaskStore', () => {
  it('stores a task and reads it back exactly', () => {
    const { store } = open();
    const created = store.create({
      ...newTask(),
      conversationId: undefined,
      complexity: 'multi_step',
    });
    expect(created).toMatchObject({
      id: 'task_1',
      state: 'CREATED',
      language: 'en',
      source: 'chat',
      complexity: 'multi_step',
      planFirst: true,
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
    });
    expect(created.plan).toBeUndefined();
    expect(store.get('nope')).toBeUndefined();
  });

  it('round-trips everything the engine keeps, including what it is waiting for', () => {
    const { store } = open();
    store.create(newTask());
    const plan = {
      summary: 'Move it',
      steps: [
        { id: 's1', title: 'Find', toolHint: 'find_files', optional: false, dependsOn: [] },
        {
          id: 's2',
          title: 'Move',
          detail: 'to Documents',
          expected: 'it is there',
          optional: true,
          dependsOn: ['s1'],
        },
      ],
      successCriteria: 'The file is in Documents',
    };
    const next = store.update('task_1', {
      state: 'WAITING_FOR_USER',
      plan,
      pending: { kind: 'declined', tool: 'move_file', summary: 'Move a to b' },
      resumeState: 'EXECUTING',
      riskLevel: 'HIGH',
      error: { code: 'CANCELLED', message: 'x', retryable: false },
      resultSummary: 'Half done',
      outcome: 'partial',
      modelLabel: 'Some model',
      usage: {
        toolCalls: 3,
        modelTurns: 5,
        inputTokens: 100,
        outputTokens: 50,
        questions: 1,
        elapsedMs: 1234,
      },
      filesChanged: 2,
      actionCount: 3,
      startedAt: 5,
    });
    expect(next).toMatchObject({
      state: 'WAITING_FOR_USER',
      plan,
      pending: { kind: 'declined', tool: 'move_file', summary: 'Move a to b' },
      resumeState: 'EXECUTING',
      riskLevel: 'HIGH',
      error: { code: 'CANCELLED' },
      resultSummary: 'Half done',
      outcome: 'partial',
      modelLabel: 'Some model',
      usage: { toolCalls: 3, questions: 1, elapsedMs: 1234 },
      filesChanged: 2,
      startedAt: 5,
    });
    expect(store.get('task_1')).toEqual(next);
  });

  it('clears a field when the patch says undefined', () => {
    const { store } = open();
    store.create(newTask());
    store.update('task_1', {
      pending: { kind: 'plan_approval' },
      resumeState: 'READY',
      pausedFrom: 'EXECUTING',
    });
    const cleared = store.update('task_1', {
      pending: undefined,
      resumeState: undefined,
      pausedFrom: undefined,
    });
    expect(cleared.pending).toBeUndefined();
    expect(cleared.resumeState).toBeUndefined();
    expect(cleared.pausedFrom).toBeUndefined();
    expect(store.get('task_1')!.pending).toBeUndefined();
  });

  it('bumps updatedAt on every change, and lists newest first', () => {
    const { store, repo } = open();
    const a = store.create(newTask('task_a'));
    const b = store.create(newTask('task_b'));
    expect(repo.list().map((r) => r.id)).toEqual(['task_b', 'task_a']);
    const updated = store.update('task_a', { title: 'Renamed' });
    expect(updated.updatedAt).toBeGreaterThan(a.updatedAt);
    expect(store.get('task_b')!.updatedAt).toBe(b.updatedAt);
  });

  it('finds tasks by state, oldest first', () => {
    const { store } = open();
    store.create(newTask('task_a'));
    store.create(newTask('task_b'));
    store.create(newTask('task_c'));
    store.update('task_a', { state: 'EXECUTING' });
    store.update('task_c', { state: 'EXECUTING' });
    store.update('task_b', { state: 'COMPLETED' });
    expect(store.listByState(['EXECUTING', 'PAUSED']).map((t) => t.id)).toEqual([
      'task_a',
      'task_c',
    ]);
    expect(store.listByState([])).toEqual([]);
  });

  it('keeps steps in order, replaces the whole plan at once, and updates one step', () => {
    const { store } = open();
    store.create(newTask());
    store.replaceSteps('task_1', [
      step('task_1', 1, { title: 'Second' }),
      step('task_1', 0, { title: 'First', toolHint: 'find_files', detail: 'in Downloads' }),
    ]);
    expect(store.steps('task_1').map((s) => s.title)).toEqual(['First', 'Second']);
    expect(store.steps('task_1')[0]).toMatchObject({
      planStepId: 's1',
      toolHint: 'find_files',
      detail: 'in Downloads',
      optional: false,
      dependsOn: [],
      state: 'pending',
      attempts: 0,
      unverified: false,
    });

    const updated = store.updateStep('step_task_1_0', {
      state: 'done',
      attempts: 2,
      summary: 'Found it',
      evidence: '✓ found',
      unverified: true,
      retryNote: 'careful',
      startedAt: 10,
      completedAt: 20,
      error: 'earlier problem',
    });
    expect(updated).toMatchObject({
      state: 'done',
      attempts: 2,
      summary: 'Found it',
      evidence: '✓ found',
      unverified: true,
      retryNote: 'careful',
      startedAt: 10,
      completedAt: 20,
      error: 'earlier problem',
    });
    expect(
      store.updateStep('step_task_1_0', { error: undefined, retryNote: undefined }),
    ).toMatchObject({
      error: undefined,
      retryNote: undefined,
      summary: 'Found it',
    });

    store.replaceSteps('task_1', [step('task_1', 0, { id: 'step_new', title: 'Only' })]);
    expect(store.steps('task_1').map((s) => s.id)).toEqual(['step_new']);
    expect(() => store.updateStep('step_missing', { state: 'done' })).toThrow(/not found/);
  });

  it('numbers timeline events without gaps, per task', () => {
    const { store } = open();
    store.create(newTask('task_a'));
    store.create(newTask('task_b'));
    store.appendEvent('task_a', 'TASK_CREATED');
    store.appendEvent('task_b', 'TASK_CREATED');
    store.appendEvent('task_a', 'STATE_CHANGED', { from: 'CREATED', to: 'ANALYZING' });
    const events = store.events('task_a');
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'TASK_CREATED'],
      [2, 'STATE_CHANGED'],
    ]);
    expect(events[1]!.payload).toEqual({ from: 'CREATED', to: 'ANALYZING' });
    expect(store.events('task_b')).toHaveLength(1);
  });

  it('never stores an oversized event payload', () => {
    const { store } = open();
    store.create(newTask());
    store.appendEvent('task_1', 'TOOL_COMPLETED', { summary: 'x'.repeat(10_000) });
    expect(store.events('task_1')[0]!.payload).toEqual({ truncated: true });
  });

  it('degrades, rather than crashes, on damaged rows', () => {
    const { store, handle } = open();
    store.create(newTask());
    store.replaceSteps('task_1', [step('task_1', 0)]);
    store.appendEvent('task_1', 'TASK_CREATED');
    const db = handle.db;
    db.update(schema.tasks)
      .set({
        runtimeJson: '{not json',
        planJson: '{"summary": 5}',
        errorJson: 'null',
        state: 'SOMETHING_ELSE',
        riskLevel: 'HUGE',
        source: 'telepathy',
        complexity: 'gigantic',
        language: 'fr',
      })
      .where(eq(schema.tasks.id, 'task_1'))
      .run();
    db.update(schema.taskSteps)
      .set({ dataJson: '[1,2', state: 'levitating' })
      .where(eq(schema.taskSteps.taskId, 'task_1'))
      .run();
    db.update(schema.taskEvents)
      .set({ payloadJson: '[1]', type: 'MYSTERY' })
      .where(eq(schema.taskEvents.taskId, 'task_1'))
      .run();

    const task = store.get('task_1')!;
    // An unreadable state is shown as failed — never as something still running.
    expect(task).toMatchObject({
      state: 'FAILED',
      riskLevel: 'LOW',
      source: 'chat',
      language: 'en',
      planFirst: false,
      usage: { toolCalls: 0 },
    });
    expect(task.plan).toBeUndefined();
    expect(task.complexity).toBeUndefined();
    expect(store.steps('task_1')[0]).toMatchObject({
      state: 'failed',
      planStepId: 's1',
      attempts: 0,
    });
    expect(store.events('task_1')[0]).toMatchObject({ type: 'STATE_CHANGED' });
    expect(store.events('task_1')[0]!.payload).toBeUndefined();
  });

  it('removes steps and timeline with the task', () => {
    const { store, repo, handle } = open();
    store.create(newTask());
    store.replaceSteps('task_1', [step('task_1', 0)]);
    store.appendEvent('task_1', 'TASK_CREATED');
    expect(repo.remove('task_1')).toBe(true);
    expect(store.get('task_1')).toBeUndefined();
    expect(handle.db.select().from(schema.taskSteps).all()).toEqual([]);
    expect(handle.db.select().from(schema.taskEvents).all()).toEqual([]);
    expect(repo.remove('task_1')).toBe(false);
  });

  it('keeps the audit trail when a task is removed (tool calls are detached, not deleted)', () => {
    const { store, repo, handle } = open();
    store.create(newTask());
    handle.db
      .insert(schema.toolCalls)
      .values({
        id: 'call_1',
        taskId: 'task_1',
        toolName: 'move_file',
        argumentsJson: '{}',
        risk: 'MEDIUM',
        permissionDecision: 'allowed',
        status: 'success',
      })
      .run();
    handle.db
      .insert(schema.toolResults)
      .values({ id: 'res_1', toolCallId: 'call_1', ok: true })
      .run();
    repo.remove('task_1');
    const rows = handle.db.select().from(schema.toolCalls).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'call_1', taskId: null, toolName: 'move_file' });
    expect(handle.db.select().from(schema.toolResults).all()).toHaveLength(1);
  });
});
