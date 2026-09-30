import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomationTools } from '@allaya/automation';
import { schema } from '@allaya/database';
import type {
  AutomationRunView,
  AutomationView,
  TaskSummary,
  Workflow,
  WorkflowStep,
} from '@allaya/validation';
import { API_KEY } from '../helpers/anthropic';
import { createTestBackend, type TestBackend } from '../helpers/backend';
import {
  aiCall,
  aiStepDone,
  aiStepFailed,
  aiTurn,
  fakeAi,
  type FakeAiScript,
} from '../helpers/fake-ai';
import { fsFixture, type FsFixture } from '../helpers/fs-fixture';

// Each step is a real task, so a run of several takes a few seconds.
vi.setConfig({ testTimeout: 30_000 });

const backends: TestBackend[] = [];
let fx: FsFixture | undefined;
const scratch: string[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
  fx?.cleanup();
  fx = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Ok<T> = { ok: true; data: T };
type Failed = { ok: false; error: { code: string; details?: Record<string, unknown> } };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const failure = (r: unknown) => (r as Failed).error;

let n = 0;
const id = () => `w${(n += 1)}`;
const action = (instruction: string, extra: Record<string, unknown> = {}): WorkflowStep => ({
  type: 'action',
  id: id(),
  instruction,
  ...extra,
});
const flow = (...steps: WorkflowStep[]): Workflow => ({ steps });
/** A step the model reports as failed, in every one of the task engine's attempts. */
const failing = () => Array.from({ length: 3 }, () => aiStepFailed('No.'));
const folder = (name: string) => aiTurn(aiCall('create_folder', { path: `Documents/${name}` }));

async function rig(script: FakeAiScript, options: { databasePath?: string } = {}) {
  fx ??= fsFixture();
  const f = fx;
  const ai = fakeAi(script);
  const clock = { now: new Date(2026, 4, 4, 8, 0).getTime() };
  const backend = createTestBackend({
    fetch: ai.fetch,
    ...(options.databasePath ? { databasePath: options.databasePath } : {}),
    automations: { now: () => clock.now },
    files: {
      knownFolders: { documents: f.documents, desktop: f.desktop },
      protectedPaths: [f.appData],
      home: f.base,
      backupsFolder: join(f.appData, 'file-backups'),
      trash: f.trash,
    },
  });
  backends.push(backend);
  await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
  await backend.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
  return { backend, ai, fx: f, clock };
}

const make = async (
  b: TestBackend,
  workflow: Workflow | undefined,
  over: Record<string, unknown> = {},
) =>
  b.call('automations:create', {
    name: 'A workflow',
    instruction: workflow ? '' : 'Create a folder called X in Documents',
    ...(workflow ? { workflow } : {}),
    trigger: { kind: 'manual' },
    ...over,
  });
const runs = async (b: TestBackend, automationId: string) =>
  data<AutomationRunView[]>(await b.call('automations:runs', { id: automationId }));
const newest = async (b: TestBackend, automationId: string) => (await runs(b, automationId))[0]!;
const until = (b: TestBackend, automationId: string, check: (run: AutomationRunView) => boolean) =>
  vi.waitFor(async () => expect(check(await newest(b, automationId))).toBe(true), {
    timeout: 8000,
  });
const start = async (b: TestBackend, automationId: string) =>
  data<AutomationRunView>(await b.call('automations:runNow', { id: automationId }));

describe('saving a workflow', () => {
  it('keeps it, shows it back, and can change it back to one instruction', async () => {
    const r = await rig({});
    const workflow = flow(action('one'), action('two', { keepGoing: true }));
    const made = data<AutomationView>(await make(r.backend, workflow));
    expect(made).toMatchObject({ instruction: '', workflow });
    const listed = data<{ automations: AutomationView[] }>(
      await r.backend.call('automations:list'),
    );
    expect(listed.automations[0]!.workflow).toEqual(workflow);

    const back = data<AutomationView>(
      await r.backend.call('automations:update', {
        id: made.id,
        changes: { name: 'A workflow', instruction: 'Just this', trigger: { kind: 'manual' } },
      }),
    );
    expect(back.workflow).toBeUndefined();
    expect(back.instruction).toBe('Just this');
  });

  it('refuses what cannot work, saying why in a code the screen turns into words', async () => {
    const r = await rig({});
    const cases: Array<[Workflow | undefined, Record<string, unknown>, string]> = [
      [undefined, { instruction: '   ' }, 'nothing_to_do'],
      [{ steps: [{ type: 'approval', id: 'a', message: 'ok?' }] }, {}, 'nothing_to_do'],
      [
        flow({ type: 'loop', id: 'l', over: { kind: 'files' }, body: [action('x')] }),
        {},
        'files_loop_needs_folder',
      ],
    ];
    for (const [workflow, over, reason] of cases) {
      const result = await make(r.backend, workflow, over);
      expect(failure(result)).toMatchObject({ code: 'INVALID_INPUT', details: { reason } });
    }
    expect(
      data<{ automations: unknown[] }>(await r.backend.call('automations:list')).automations,
    ).toHaveLength(0);
  });

  it('rejects a malformed workflow before it reaches the scheduler', async () => {
    const r = await rig({});
    const bad: unknown[] = [
      { steps: [] },
      { steps: [{ type: 'action', id: 'a b', instruction: 'x' }] },
      { steps: [{ type: 'action', id: 'a', instruction: 'x', extra: 1 }] },
      { steps: [{ type: 'action', id: 'a', instruction: '' }] },
      { steps: [{ type: 'run_command', id: 'a', command: 'del *' }] },
      {
        steps: [{ type: 'loop', id: 'l', over: { kind: 'times', times: 11 }, body: [action('x')] }],
      },
      {
        steps: [
          { type: 'condition', id: 'c', if: { kind: 'previous', is: 'maybe' }, then: [], else: [] },
        ],
      },
      {
        steps: [
          {
            type: 'condition',
            id: 'c',
            if: { kind: 'time_between', from: '25:00', to: '06:00' },
            then: [],
            else: [],
          },
        ],
      },
      { steps: [{ type: 'action', id: 'a', instruction: 'x'.repeat(2001) }] },
    ];
    for (const workflow of bad) {
      const result = await r.backend.call('automations:create', {
        name: 'Bad',
        instruction: '',
        workflow,
        trigger: { kind: 'manual' },
      });
      expect(result, JSON.stringify(workflow)).toMatchObject({ ok: false });
    }
  });

  it('is not something the model can create: the chat tool takes no workflow', () => {
    const tools = createAutomationTools({
      create: async () => ({}) as never,
      get: () => undefined,
      list: () => [],
    });
    const tool = tools.find((t) => t.name === 'create_automation') as unknown as {
      parameters: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(tool).toBeDefined();
    const ok = tool.parameters.safeParse({
      name: 'x',
      instruction: 'y',
      trigger: { kind: 'manual' },
    });
    expect(ok.success).toBe(true);
    const parsed = tool.parameters.safeParse({
      name: 'x',
      instruction: 'y',
      trigger: { kind: 'manual' },
      workflow: flow(action('z')),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('running a workflow through the real task engine', () => {
  it('does its steps in order, each as an ordinary task on the audit trail', async () => {
    const r = await rig({
      steps: {
        s1: [folder('Alpha'), aiStepDone('Made Alpha.'), folder('Beta'), aiStepDone('Made Beta.')],
      },
    });
    const made = data<AutomationView>(
      await make(
        r.backend,
        flow(
          action('Create a folder called Alpha in Documents'),
          action('Create a folder called Beta in Documents'),
        ),
      ),
    );
    const run = await start(r.backend, made.id);
    expect(run).toMatchObject({ status: 'running', progress: { steps: 1 } });
    await until(r.backend, made.id, (x) => x.status === 'completed');

    expect(existsSync(join(r.fx.documents, 'Alpha'))).toBe(true);
    expect(existsSync(join(r.fx.documents, 'Beta'))).toBe(true);
    const done = await newest(r.backend, made.id);
    expect(done.progress).toMatchObject({ steps: 2 });
    const tasks = data<TaskSummary[]>(await r.backend.call('tasks:list', {}));
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.source === 'automation' && t.state === 'COMPLETED')).toBe(true);
    const calls = r.backend.container.database.db.select().from(schema.toolCalls).all();
    expect(calls.map((c) => c.toolName)).toEqual(['create_folder', 'create_folder']);
    expect(new Set(calls.map((c) => c.taskId)).size).toBe(2);
  });

  it('takes the branch the previous step decides — here, recovering from a failure', async () => {
    const r = await rig({
      steps: { s1: [...failing(), folder('Recovered'), aiStepDone('Made it.')] },
    });
    const workflow = flow(action('Create a folder called Try in Documents', { keepGoing: true }), {
      type: 'condition',
      id: id(),
      if: { kind: 'previous', is: 'failed' },
      then: [action('Create a folder called Recovered in Documents')],
      else: [action('Create a folder called Nothing in Documents')],
    });
    const made = data<AutomationView>(await make(r.backend, workflow));
    await start(r.backend, made.id);
    await until(r.backend, made.id, (x) => x.status === 'completed');
    expect(existsSync(join(r.fx.documents, 'Recovered'))).toBe(true);
    const tasks = data<TaskSummary[]>(await r.backend.call('tasks:list', {}));
    expect(tasks.map((t) => t.state).sort()).toEqual(['COMPLETED', 'FAILED']);
  });

  it('a failed step without permission to fail ends the run and starts nothing else', async () => {
    const r = await rig({ steps: { s1: [...failing(), folder('Never')] } });
    const made = data<AutomationView>(
      await make(
        r.backend,
        flow(
          action('Create a folder called Try in Documents'),
          action('Create a folder called Delta in Documents'),
        ),
      ),
    );
    await start(r.backend, made.id);
    await until(r.backend, made.id, (x) => x.status === 'failed');
    expect(existsSync(join(r.fx.documents, 'Never'))).toBe(false);
    expect(data<TaskSummary[]>(await r.backend.call('tasks:list', {}))).toHaveLength(1);
  });

  it('repeats a step the chosen number of times', async () => {
    const r = await rig({
      steps: {
        s1: [
          folder('R1'),
          aiStepDone('1'),
          folder('R2'),
          aiStepDone('2'),
          folder('R3'),
          aiStepDone('3'),
        ],
      },
    });
    const made = data<AutomationView>(
      await make(
        r.backend,
        flow({
          type: 'loop',
          id: id(),
          over: { kind: 'times', times: 3 },
          body: [action('Create a folder called Gamma in Documents')],
        }),
      ),
    );
    await start(r.backend, made.id);
    await until(r.backend, made.id, (x) => x.status === 'completed');
    expect(data<TaskSummary[]>(await r.backend.call('tasks:list', {}))).toHaveLength(3);
    for (const name of ['R1', 'R2', 'R3'])
      expect(existsSync(join(r.fx.documents, name))).toBe(true);
  });

  it("a step's own permission settings still apply: a blocked tool is refused inside a workflow too", async () => {
    const r = await rig({ steps: { s1: [folder('Blocked'), aiStepDone('x')] } });
    await r.backend.call('permissions:set', { subject: 'file_access', mode: 'never' });
    const made = data<AutomationView>(
      await make(r.backend, flow(action('Create a folder called Blocked in Documents'))),
    );
    await start(r.backend, made.id);
    await vi.waitFor(
      async () =>
        expect(['completed', 'failed', 'waiting_for_approval']).toContain(
          (await newest(r.backend, made.id)).status,
        ),
      { timeout: 15_000 },
    );
    expect(existsSync(join(r.fx.documents, 'Blocked'))).toBe(false);
  });
});

describe('approval steps', () => {
  const withApproval = () =>
    flow(
      action('Create a folder called Omega in Documents'),
      { type: 'approval', id: id(), message: 'Make the second folder too?' },
      action('Create a folder called Beta in Documents'),
    );
  const script = (): FakeAiScript => ({
    steps: {
      s1: [folder('Omega'), aiStepDone('Omega made.'), folder('Beta'), aiStepDone('Beta made.')],
    },
  });

  it('wait for the person, who is shown what they are asked, and go on when they approve', async () => {
    const r = await rig(script());
    const made = data<AutomationView>(await make(r.backend, withApproval()));
    const run = await start(r.backend, made.id);
    await until(
      r.backend,
      made.id,
      (x) => x.status === 'waiting_for_approval' && x.note === 'approval',
    );
    const waiting = await newest(r.backend, made.id);
    expect(waiting.approval).toEqual({ message: 'Make the second folder too?' });
    expect(existsSync(join(r.fx.documents, 'Omega'))).toBe(true);
    expect(existsSync(join(r.fx.documents, 'Beta'))).toBe(false);

    const decided = data<AutomationRunView>(
      await r.backend.call('automations:decide', { runId: run.id, approve: true }),
    );
    expect(decided.approval).toBeUndefined();
    await until(r.backend, made.id, (x) => x.status === 'completed');
    expect(existsSync(join(r.fx.documents, 'Beta'))).toBe(true);
  });

  it('end the run when the person says no — and the next step never starts', async () => {
    const r = await rig(script());
    const made = data<AutomationView>(await make(r.backend, withApproval()));
    const run = await start(r.backend, made.id);
    await until(r.backend, made.id, (x) => x.note === 'approval');
    await r.backend.call('automations:decide', { runId: run.id, approve: false });
    expect(await newest(r.backend, made.id)).toMatchObject({
      status: 'cancelled',
      note: 'declined',
    });
    expect(existsSync(join(r.fx.documents, 'Beta'))).toBe(false);
  });

  it('cannot be answered twice, or for a run that is not waiting, or one that does not exist', async () => {
    const r = await rig(script());
    const made = data<AutomationView>(await make(r.backend, withApproval()));
    const run = await start(r.backend, made.id);
    expect(
      failure(await r.backend.call('automations:decide', { runId: run.id, approve: true })),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    await until(r.backend, made.id, (x) => x.note === 'approval');
    await r.backend.call('automations:decide', { runId: run.id, approve: true });
    expect(
      failure(await r.backend.call('automations:decide', { runId: run.id, approve: true })),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      failure(await r.backend.call('automations:decide', { runId: 'run_nope', approve: true })),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('are ended by the emergency stop — a stale "yes" later cannot start anything', async () => {
    const r = await rig(script());
    const made = data<AutomationView>(await make(r.backend, withApproval()));
    const run = await start(r.backend, made.id);
    await until(r.backend, made.id, (x) => x.note === 'approval');
    await r.backend.call('agent:stop');
    await until(r.backend, made.id, (x) => x.status === 'cancelled');
    expect(await newest(r.backend, made.id)).toMatchObject({ note: 'stopped' });
    expect(
      failure(await r.backend.call('automations:decide', { runId: run.id, approve: true })),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(existsSync(join(r.fx.documents, 'Beta'))).toBe(false);
  });

  it('are still waiting after Allaya is closed and opened again', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'allaya-wf-')), 'db.sqlite');
    scratch.push(join(path, '..'));
    const first = await rig(script(), { databasePath: path });
    const made = data<AutomationView>(await make(first.backend, withApproval()));
    const run = await start(first.backend, made.id);
    await until(first.backend, made.id, (x) => x.note === 'approval');
    first.backend.dispose();
    backends.splice(backends.indexOf(first.backend), 1);

    const second = await rig(
      { steps: { s1: [folder('Beta'), aiStepDone('Beta made.')] } },
      { databasePath: path },
    );
    await second.backend.container.automations.scheduler.tick();
    expect(await newest(second.backend, made.id)).toMatchObject({
      status: 'waiting_for_approval',
      note: 'approval',
      approval: { message: 'Make the second folder too?' },
    });
    await second.backend.call('automations:decide', { runId: run.id, approve: true });
    await until(second.backend, made.id, (x) => x.status === 'completed');
    expect(existsSync(join(second.fx.documents, 'Beta'))).toBe(true);
  }, 30_000);
});
