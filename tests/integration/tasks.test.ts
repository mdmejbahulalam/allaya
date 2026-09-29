import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, schema, sourceMigrationsFolder } from '@allaya/database';
import type { MessageView, TaskDetail, TaskSummary } from '@allaya/validation';
import { API_KEY } from '../helpers/anthropic';
import { createTestBackend, type TestBackend } from '../helpers/backend';
import {
  aiCall,
  aiFinish,
  aiPlan,
  aiStepDone,
  aiStepFailed,
  aiTurn,
  fakeAi,
  type FakeAi,
  type FakeAiScript,
} from '../helpers/fake-ai';
import { fsFixture, type FsFixture } from '../helpers/fs-fixture';

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
type Failed = { ok: false; error: { code: string; message: string } };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const failure = (r: unknown) => (r as Failed).error;

const filesOption = (f: FsFixture) => ({
  knownFolders: { documents: f.documents, desktop: f.desktop },
  protectedPaths: [f.appData],
  home: f.base,
  backupsFolder: join(f.appData, 'file-backups'),
  trash: f.trash,
});

interface Rig {
  backend: TestBackend;
  ai: FakeAi;
  fx: FsFixture;
}

async function rig(
  script: FakeAiScript,
  options: { databasePath?: string; allowFiles?: boolean; tasks?: TestBackendOptionsTasks } = {},
): Promise<Rig> {
  fx ??= fsFixture();
  const ai = fakeAi(script);
  const backend = createTestBackend({
    fetch: ai.fetch,
    files: filesOption(fx),
    ...(options.databasePath ? { databasePath: options.databasePath } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
  });
  backends.push(backend);
  await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
  if (options.allowFiles !== false) {
    await backend.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
  }
  return { backend, ai, fx };
}
type TestBackendOptionsTasks = NonNullable<Parameters<typeof createTestBackend>[0]>['tasks'];

const create = async (b: TestBackend, request: string, planFirst?: boolean) =>
  data<TaskSummary>(
    await b.call('tasks:create', { request, ...(planFirst !== undefined ? { planFirst } : {}) }),
  );
const detail = async (b: TestBackend, id: string) =>
  data<TaskDetail>(await b.call('tasks:get', { id }));
const stateOf = (b: TestBackend, id: string) => b.container.tasks.get(id).task.state;
const untilState = (b: TestBackend, id: string, state: string) =>
  vi.waitFor(() => expect(stateOf(b, id)).toBe(state), { timeout: 5000 });
const untilCalls = (ai: FakeAi, count: number) =>
  vi.waitFor(() => expect(ai.calls.length).toBeGreaterThanOrEqual(count), { timeout: 5000 });

const TWO_STEPS = 'First create a folder called Reports in Documents, then save a note in it.';
const twoStepPlan = () =>
  aiPlan({
    summary: 'Make the folder and save the note',
    steps: [
      { id: 's1', title: 'Create the Reports folder', tool: 'create_folder' },
      {
        id: 's2',
        title: 'Save the note',
        tool: 'write_file',
        dependsOn: ['s1'],
        expected: 'Documents/Reports/note.txt exists',
      },
    ],
    successCriteria: 'The note is in Documents/Reports',
  });
const happyScript = (): FakeAiScript => ({
  plan: [twoStepPlan()],
  steps: {
    s1: [
      aiTurn(aiCall('create_folder', { path: 'Documents/Reports' })),
      aiStepDone('Created the Reports folder.'),
    ],
    s2: [
      aiTurn(aiCall('write_file', { path: 'Documents/Reports/note.txt', content: 'hello' })),
      aiStepDone('Saved note.txt.'),
    ],
  },
  summary: [aiFinish('achieved', 'I made the Reports folder and saved your note in it.')],
});

describe('a task, end to end', () => {
  it('plans, acts through the real tool pipeline, checks the results and answers', async () => {
    const { backend, ai, fx: f } = await rig(happyScript());
    const created = await create(backend, TWO_STEPS);
    expect(created.state).not.toBe('COMPLETED');
    await untilState(backend, created.id, 'COMPLETED');

    // The effects are real, on disk, in the right place.
    expect(readFileSync(join(f.documents, 'Reports', 'note.txt'), 'utf8')).toBe('hello');

    const d = await detail(backend, created.id);
    expect(d.task).toMatchObject({
      state: 'COMPLETED',
      outcome: 'achieved',
      resultSummary: 'I made the Reports folder and saved your note in it.',
      stepCount: 2,
      stepsDone: 2,
      actionCount: 2,
      filesChanged: 2,
      language: 'en',
      source: 'palette',
      running: false,
      queued: false,
    });
    expect(d.plan?.summary).toBe('Make the folder and save the note');
    expect(d.steps.map((s) => [s.planStepId, s.state, s.unverified])).toEqual([
      ['s1', 'done', false],
      ['s2', 'done', false],
    ]);
    // What the tools showed is on the record next to what the model said.
    expect(d.steps[0]!.evidence).toMatch(/✓.*Reports/);
    expect(d.steps[0]!.summary).toBe('Created the Reports folder.');
    expect(d.usage.toolCalls).toBe(2);
    expect(d.usage.modelTurns).toBe(6);
    const types = d.events.map((e) => e.type);
    for (const expected of [
      'TASK_CREATED',
      'PLAN_CREATED',
      'STEP_STARTED',
      'TOOL_COMPLETED',
      'STEP_COMPLETED',
      'VERIFICATION_COMPLETED',
      'TASK_COMPLETED',
    ]) {
      expect(types).toContain(expected);
    }
    // The tool calls are audited *under this task*.
    const rows = backend.container.database.db.select().from(schema.toolCalls).all();
    expect(rows.filter((r) => r.taskId === created.id).map((r) => r.toolName)).toEqual([
      'create_folder',
      'write_file',
    ]);
    // The model was offered the control tools inside steps, and never the chat-only one.
    const stepTools = ai.calls.find((c) => c.kind === 'step')!.request.body as {
      tools: Array<{ name: string }>;
    };
    const names = stepTools.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['create_folder', 'write_file', 'finish_step', 'ask_user']),
    );
    expect(names).not.toContain('start_task');
    expect(names).not.toContain('submit_plan');
  });

  it('pushes changes to the UI as they happen, and keeps the list newest first', async () => {
    const { backend } = await rig(happyScript());
    const created = await create(backend, TWO_STEPS);
    await untilState(backend, created.id, 'COMPLETED');
    const changes = backend.eventsOf('tasks:changed') as TaskSummary[];
    const seen = changes.filter((c) => c.id === created.id).map((c) => c.state);
    expect(seen).toContain('PLANNING');
    expect(seen).toContain('EXECUTING');
    expect(seen.at(-1)).toBe('COMPLETED');
    const statuses = (backend.eventsOf('agent:status') as Array<{ status: string }>).map(
      (e) => e.status,
    );
    expect(statuses).toContain('thinking');
    expect(statuses).toContain('working');
    expect(statuses).toContain('completed');
    const list = data<TaskSummary[]>(await backend.call('tasks:list'));
    expect(list[0]!.id).toBe(created.id);
  });

  it('runs a simple request as one step with no planning call', async () => {
    const {
      backend,
      ai,
      fx: f,
    } = await rig({
      steps: {
        s1: [
          aiTurn(aiCall('create_folder', { path: 'Documents/Solo' })),
          aiStepDone('Created Solo.'),
        ],
      },
    });
    const created = await create(backend, 'Create a folder called Solo in Documents');
    await untilState(backend, created.id, 'COMPLETED');
    expect(existsSync(join(f.documents, 'Solo'))).toBe(true);
    expect(ai.calls.map((c) => c.kind)).toEqual(['step', 'step']);
    expect((await detail(backend, created.id)).task.resultSummary).toBe('Created Solo.');
  });

  it('works in Bengali: the planner is told to answer in Bengali and the task remembers the language', async () => {
    const { backend, ai } = await rig({
      plan: [
        aiPlan({
          summary: 'ফোল্ডার বানানো',
          steps: [{ id: 's1', title: 'Reports ফোল্ডার বানাও', tool: 'create_folder' }],
        }),
      ],
      steps: {
        s1: [
          aiTurn(aiCall('create_folder', { path: 'Documents/Reports' })),
          aiStepDone('Reports ফোল্ডার বানানো হয়েছে।'),
        ],
      },
    });
    const created = await create(backend, 'প্রথমে Reports ফোল্ডার বানাও, তারপর আমাকে জানাও');
    expect(created.language).toBe('bn');
    await untilState(backend, created.id, 'COMPLETED');
    const planner = ai.calls.find((c) => c.kind === 'plan')!.request.body as { system: string };
    expect(planner.system).toMatch(/Bengali \(Bengali script\)/);
    // One step: the answer is that step's own report.
    expect((await detail(backend, created.id)).task.resultSummary).toBe(
      'Reports ফোল্ডার বানানো হয়েছে।',
    );
  });
});

describe('the task IPC surface', () => {
  it('validates what the renderer sends and answers unknown ids plainly', async () => {
    const { backend } = await rig({});
    expect(failure(await backend.call('tasks:create', { request: '   ' })).code).toBe(
      'INVALID_IPC_PAYLOAD',
    );
    expect(failure(await backend.call('tasks:create', { request: 'x'.repeat(9000) })).code).toBe(
      'INVALID_IPC_PAYLOAD',
    );
    expect(
      failure(await backend.call('tasks:create', { request: 'ok', planFirst: 'yes' })).code,
    ).toBe('INVALID_IPC_PAYLOAD');
    expect(failure(await backend.call('tasks:get', { id: 'task_missing' })).code).toBe('NOT_FOUND');
    for (const channel of [
      'tasks:approve',
      'tasks:reject',
      'tasks:resume',
      'tasks:cancel',
      'tasks:pause',
      'tasks:remove',
    ] as const) {
      expect(failure(await backend.call(channel, { id: 'task_missing' })).code).toBe('NOT_FOUND');
    }
    expect(
      failure(await backend.call('tasks:answer', { id: 'task_missing', text: 'x' })).code,
    ).toBe('NOT_FOUND');
    expect(failure(await backend.call('tasks:answer', { id: 'x', text: '' })).code).toBe(
      'INVALID_IPC_PAYLOAD',
    );
  });

  it('refuses approvals nobody asked for', async () => {
    const { backend } = await rig(happyScript());
    const created = await create(backend, TWO_STEPS);
    await untilState(backend, created.id, 'COMPLETED');
    expect(failure(await backend.call('tasks:approve', { id: created.id })).code).toBe('CONFLICT');
    expect(failure(await backend.call('tasks:resume', { id: created.id })).code).toBe('CONFLICT');
  });

  it('removes finished tasks and their history, but not running ones', async () => {
    const { backend } = await rig({ plan: ['hang'] });
    const running = await create(backend, TWO_STEPS);
    await vi.waitFor(() => expect(stateOf(backend, running.id)).toBe('PLANNING'), {
      timeout: 5000,
    });
    expect(failure(await backend.call('tasks:remove', { id: running.id })).code).toBe('CONFLICT');
    await backend.call('tasks:cancel', { id: running.id });
    await untilState(backend, running.id, 'CANCELLED');
    expect(
      data<{ removed: boolean }>(await backend.call('tasks:remove', { id: running.id })).removed,
    ).toBe(true);
    expect(failure(await backend.call('tasks:get', { id: running.id })).code).toBe('NOT_FOUND');
    expect(backend.eventsOf('tasks:removed')).toEqual([{ ids: [running.id] }]);
    expect(data<TaskSummary[]>(await backend.call('tasks:list'))).toEqual([]);
    // The history went with it.
    const db = backend.container.database.db;
    expect(db.select().from(schema.taskEvents).all()).toEqual([]);
    expect(db.select().from(schema.taskSteps).all()).toEqual([]);
  });

  it('clears all finished tasks at once and leaves the rest', async () => {
    const { backend } = await rig({ ...happyScript(), plan: [twoStepPlan(), 'hang'] });
    const done = await create(backend, TWO_STEPS);
    await untilState(backend, done.id, 'COMPLETED');
    const running = await create(backend, TWO_STEPS);
    await vi.waitFor(() => expect(stateOf(backend, running.id)).toBe('PLANNING'), {
      timeout: 5000,
    });
    expect(data<{ removed: number }>(await backend.call('tasks:clearFinished')).removed).toBe(1);
    const list = data<TaskSummary[]>(await backend.call('tasks:list'));
    expect(list.map((t) => t.id)).toEqual([running.id]);
  });
});

describe('a task started from chat', () => {
  it('is started by the model, runs in the background, and posts its result into the conversation', async () => {
    const script = happyScript();
    const { backend, ai } = await rig({
      ...script,
      chat: [
        aiTurn(aiCall('start_task', { request: TWO_STEPS })),
        { text: ['I have started that for you.'] },
      ],
    });
    const sent = data<{ conversation: { id: string }; assistantMessage: MessageView }>(
      await backend.call('chat:send', { text: TWO_STEPS }),
    );
    const conversationId = sent.conversation.id;

    // Chat's own request offered start_task and told the model when to use it.
    const chatRequest = ai.calls.find((c) => c.kind === 'chat')!.request.body as {
      system: string;
      tools: Array<{ name: string }>;
    };
    expect(chatRequest.tools.map((t) => t.name)).toContain('start_task');
    expect(chatRequest.system).toMatch(/call start_task/);

    await vi.waitFor(
      () => {
        const messages = backend.container.chat.getMessages(conversationId);
        expect(messages.some((m) => m.taskId)).toBe(true);
      },
      { timeout: 6000 },
    );
    const messages = backend.container.chat.getMessages(conversationId);
    const reply = messages.find((m) => m.kind === 'assistant' && !m.taskId)!;
    expect(reply.content).toBe('I have started that for you.');
    expect(reply.actions?.[0]).toMatchObject({ tool: 'start_task', status: 'success' });
    const result = messages.find((m) => m.taskId)!;
    expect(result.content).toBe('I made the Reports folder and saved your note in it.');
    const task = backend.container.tasks.list()[0]!;
    expect(task).toMatchObject({
      state: 'COMPLETED',
      conversationId,
      source: 'chat',
      complexity: 'multi_step',
    });
    expect(result.taskId).toBe(task.id);
    // The chat screen is told about it like any other finished reply.
    const finished = backend.eventsOf('chat:finished') as Array<{ message: MessageView }>;
    expect(finished.some((e) => e.message.taskId === task.id)).toBe(true);
  });

  it('cannot start a task inside a task, and a task never sees start_task', async () => {
    const { backend } = await rig({
      plan: [aiPlan({ steps: [{ id: 's1', title: 'Do it', tool: 'create_folder' }] })],
      steps: {
        s1: [
          aiTurn(aiCall('start_task', { request: 'do it again' })),
          aiStepFailed('There is no such tool.'),
          aiStepFailed('still none'),
          aiStepFailed('still none'),
        ],
      },
    });
    const created = await create(backend, TWO_STEPS);
    await untilState(backend, created.id, 'FAILED');
    // Only the one task exists: nothing was started by the model inside it.
    expect(backend.container.tasks.list()).toHaveLength(1);
    const rows = backend.container.database.db.select().from(schema.toolCalls).all();
    expect(rows.find((r) => r.toolName === 'start_task')?.status).not.toBe('success');
  });
});

describe('when a task needs the person', () => {
  it('asks in the conversation, takes the answer from a chat message, and carries on', async () => {
    const { backend, fx: f } = await rig({
      chat: [aiTurn(aiCall('start_task', { request: TWO_STEPS })), { text: ['Started.'] }],
      plan: [aiPlan({ question: 'Which folder should the note go in?' }), twoStepPlan()],
      steps: happyScript().steps!,
      summary: happyScript().summary!,
    });
    const sent = data<{ conversation: { id: string } }>(
      await backend.call('chat:send', { text: TWO_STEPS }),
    );
    const conversationId = sent.conversation.id;
    const taskId = await vi.waitFor(
      () => {
        const t = backend.container.tasks.list()[0];
        expect(t?.state).toBe('WAITING_FOR_USER');
        return t!.id;
      },
      { timeout: 6000 },
    );
    expect(backend.container.tasks.list()[0]!.pending).toEqual({
      kind: 'question',
      question: 'Which folder should the note go in?',
    });
    // The question is in the conversation, linked to the task.
    await vi.waitFor(
      () =>
        expect(
          backend.container.chat
            .getMessages(conversationId)
            .some(
              (m) => m.taskId === taskId && m.content === 'Which folder should the note go in?',
            ),
        ).toBe(true),
      { timeout: 3000 },
    );

    // A plain message answers it.
    const replied = data<{ assistantMessage: MessageView }>(
      await backend.call('chat:send', { conversationId, text: 'Documents please' }),
    );
    expect(replied.assistantMessage.content).toBe('Thanks — carrying on.');
    await untilState(backend, taskId, 'COMPLETED');
    expect(existsSync(join(f.documents, 'Reports', 'note.txt'))).toBe(true);
    expect((await detail(backend, taskId)).request).toMatch(
      /Answer from the user: Documents please/,
    );
  });

  it('shows the plan first when asked, and acts only after approval — which never replaces per-action confirmation', async () => {
    const { backend, fx: f } = await rig({
      plan: [
        aiPlan({
          summary: 'Trash the old draft',
          steps: [{ id: 's1', title: 'Move draft.txt to the trash', tool: 'delete_file' }],
        }),
      ],
      steps: {
        s1: [
          aiTurn(aiCall('delete_file', { path: 'Documents/draft.txt' })),
          aiStepDone('Moved draft.txt to the trash.'),
        ],
      },
      summary: [aiFinish('achieved', 'draft.txt is in the trash.')],
    });
    f.write('Documents/draft.txt', 'old');
    const created = await create(backend, 'First look at draft.txt, then trash it.');
    await untilState(backend, created.id, 'WAITING_FOR_USER');
    const waiting = await detail(backend, created.id);
    expect(waiting.task.pending).toEqual({ kind: 'plan_approval' });
    expect(waiting.assessment).toMatchObject({
      needsApproval: true,
      risk: 'HIGH',
      tools: ['delete_file'],
    });
    expect(waiting.assessment?.reasons).toEqual(
      expect.arrayContaining(['risky_tool', 'sensitive_subject']),
    );
    // Nothing has happened yet.
    expect(existsSync(join(f.documents, 'draft.txt'))).toBe(true);
    expect(backend.container.tools.pendingConfirmations()).toEqual([]);

    await backend.call('tasks:approve', { id: created.id });
    // Approving the plan is not approving the deletion: that still asks, on its own.
    await vi.waitFor(() => expect(backend.container.tools.pendingConfirmations()).toHaveLength(1), {
      timeout: 5000,
    });
    expect(existsSync(join(f.documents, 'draft.txt'))).toBe(true);
    const confirmation = backend.container.tools.pendingConfirmations()[0]!;
    expect(confirmation.tool).toBe('delete_file');
    await backend.call('tools:respondConfirmation', { id: confirmation.id, decision: 'approved' });
    await untilState(backend, created.id, 'COMPLETED');
    expect(existsSync(join(f.documents, 'draft.txt'))).toBe(false);
  });

  it('stops for good, having done nothing, when the plan is rejected', async () => {
    const { backend, fx: f } = await rig({
      plan: [aiPlan({ steps: [{ id: 's1', title: 'Trash it', tool: 'delete_file' }] })],
    });
    f.write('Documents/keep.txt', 'keep');
    const created = await create(backend, 'First look at keep.txt, then trash it.');
    await untilState(backend, created.id, 'WAITING_FOR_USER');
    await backend.call('tasks:reject', { id: created.id });
    expect(stateOf(backend, created.id)).toBe('CANCELLED');
    expect(existsSync(join(f.documents, 'keep.txt'))).toBe(true);
    expect(backend.container.database.db.select().from(schema.toolCalls).all()).toEqual([]);
  });

  it('stops the step when the person declines an action, then continues or ends as they choose', async () => {
    const { backend, fx: f } = await rig({
      plan: [
        aiPlan({
          steps: [
            { id: 's1', title: 'Trash old.txt', tool: 'delete_file' },
            { id: 's2', title: 'Create the folder Archive', tool: 'create_folder' },
          ],
        }),
      ],
      steps: {
        s1: [aiTurn(aiCall('delete_file', { path: 'Documents/old.txt' }))],
        s2: [
          aiTurn(aiCall('create_folder', { path: 'Documents/Archive' })),
          aiStepDone('Created Archive.'),
        ],
      },
      summary: [aiFinish('achieved', 'Everything is done!')],
    });
    f.write('Documents/old.txt', 'old');
    const created = await create(backend, 'First trash old.txt, then create the folder Archive.');
    await untilState(backend, created.id, 'WAITING_FOR_USER');
    await backend.call('tasks:approve', { id: created.id });
    await vi.waitFor(() => expect(backend.container.tools.pendingConfirmations()).toHaveLength(1), {
      timeout: 5000,
    });
    await backend.call('tools:respondConfirmation', {
      id: backend.container.tools.pendingConfirmations()[0]!.id,
      decision: 'rejected',
    });
    await vi.waitFor(
      () => expect(backend.container.tasks.get(created.id).task.pending?.kind).toBe('declined'),
      { timeout: 5000 },
    );
    expect(existsSync(join(f.documents, 'old.txt'))).toBe(true);

    await backend.call('tasks:resume', { id: created.id });
    await untilState(backend, created.id, 'COMPLETED');
    const d = await detail(backend, created.id);
    // The model said "everything is done"; the record says a required step was declined.
    expect(d.task.outcome).toBe('partial');
    expect(d.task.resultSummary).toMatch(/Not done: Trash old\.txt/);
    expect(existsSync(join(f.documents, 'old.txt'))).toBe(true);
    expect(existsSync(join(f.documents, 'Archive'))).toBe(true);
  });
});

describe('a task has no more power than a chat message', () => {
  it('cannot reach outside the user’s folders, secrets or protected paths — and does not retry a refusal', async () => {
    const f = (fx ??= fsFixture());
    const { backend } = await rig({
      plan: [
        aiPlan({
          steps: [{ id: 's1', title: 'Read some files', tool: 'read_file' }],
        }),
      ],
      steps: {
        s1: [
          aiTurn(
            aiCall('read_file', { path: join(f.outside, 'notes.txt') }),
            aiCall('read_file', { path: join(f.appData, 'allaya.db') }),
            aiCall('read_file', { path: 'Documents/.env' }),
          ),
          aiStepFailed('Those locations are not available.'),
        ],
      },
    });
    f.write('Outside/notes.txt', 'PRIVATE-NOTES-CONTENT');
    f.write('Documents/.env', 'SECRET=1');
    const created = await create(backend, 'First read the files, then summarise them.');
    await untilState(backend, created.id, 'FAILED');
    const d = await detail(backend, created.id);
    // One attempt: a refusal is final, so nothing tempts the model into a workaround.
    expect(d.steps[0]!.attempts).toBe(1);
    const rows = backend.container.database.db.select().from(schema.toolCalls).all();
    expect(rows).toHaveLength(3);
    const results = backend.container.database.db.select().from(schema.toolResults).all();
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(JSON.stringify(results)).not.toContain('SECRET=1');
    expect(JSON.stringify(results)).not.toContain('PRIVATE-NOTES-CONTENT');
  });

  it('respects a permission the user switched off: the task fails plainly, without retrying', async () => {
    const { backend } = await rig(
      {
        plan: [aiPlan({ steps: [{ id: 's1', title: 'Make a folder', tool: 'create_folder' }] })],
        steps: {
          s1: [
            aiTurn(aiCall('create_folder', { path: 'Documents/X' })),
            aiStepFailed('File access is turned off.'),
          ],
        },
      },
      { allowFiles: false },
    );
    await backend.call('permissions:set', { subject: 'file_access', mode: 'never' });
    const created = await create(backend, 'First make a folder, then tell me.');
    await untilState(backend, created.id, 'FAILED');
    expect((await detail(backend, created.id)).steps[0]!.attempts).toBe(1);
  });

  it('records a step as unconfirmed when nothing could check it', async () => {
    const { backend } = await rig({
      plan: [aiPlan({ steps: [{ id: 's1', title: 'Look around', tool: 'list_folder' }] })],
      steps: {
        s1: [aiTurn(aiCall('list_folder', { path: 'Documents' })), aiStepDone('Listed Documents.')],
      },
      summary: [aiFinish('achieved', 'Listed.')],
    });
    const created = await create(backend, 'First list Documents, then tell me.');
    await untilState(backend, created.id, 'COMPLETED');
    const d = await detail(backend, created.id);
    expect(d.steps[0]).toMatchObject({ state: 'done', unverified: false });
    expect(d.task.actionCount).toBe(0);
  });
});

describe('stopping', () => {
  it('the emergency stop cancels the running task and the ones waiting behind it', async () => {
    const { backend, ai } = await rig({ plan: ['hang', 'hang'] });
    const first = await create(backend, TWO_STEPS);
    const second = await create(backend, TWO_STEPS);
    await untilCalls(ai, 1);
    expect(backend.container.tasks.get(second.id).task.queued).toBe(true);
    expect(backend.container.tasks.get(first.id).task.running).toBe(true);

    const stopped = data<{ cancelled: number }>(await backend.call('agent:stop'));
    expect(stopped.cancelled).toBeGreaterThanOrEqual(1);
    await untilState(backend, first.id, 'CANCELLED');
    await untilState(backend, second.id, 'CANCELLED');
    expect(backend.container.tasks.get(second.id).task.queued).toBe(false);
    expect(backend.container.runs.active()).toEqual([]);
  });

  it('the STOP button of one task cancels only that task', async () => {
    const { backend, ai } = await rig({ plan: ['hang', 'hang'] });
    const first = await create(backend, TWO_STEPS);
    await untilCalls(ai, 1);
    const second = await create(backend, TWO_STEPS);
    expect(
      data<{ cancelled: boolean }>(await backend.call('tasks:cancel', { id: second.id })).cancelled,
    ).toBe(true);
    expect(stateOf(backend, second.id)).toBe('CANCELLED');
    expect(backend.container.tasks.get(first.id).task.running).toBe(true);
    await backend.call('tasks:cancel', { id: first.id });
    await untilState(backend, first.id, 'CANCELLED');
  });

  it('typing "stop" in chat stops a task too', async () => {
    const { backend, ai } = await rig({ plan: ['hang'] });
    const created = await create(backend, TWO_STEPS);
    await untilCalls(ai, 1);
    const reply = data<{ assistantMessage: MessageView }>(
      await backend.call('chat:send', { text: 'stop' }),
    );
    expect(reply.assistantMessage.status).toBe('complete');
    await untilState(backend, created.id, 'CANCELLED');
  });

  it('pauses and resumes a running task', async () => {
    // A pause that lands while the planner is answering discards that answer, so the planner is asked again.
    const { backend, fx: f } = await rig({
      ...happyScript(),
      plan: [twoStepPlan(), twoStepPlan()],
    });
    // Pause straight away.
    const created = await create(backend, TWO_STEPS);
    expect(
      data<{ paused: boolean }>(await backend.call('tasks:pause', { id: created.id })).paused,
    ).toBe(true);
    await vi.waitFor(
      () => expect(['PAUSED', 'COMPLETED']).toContain(stateOf(backend, created.id)),
      {
        timeout: 5000,
      },
    );
    if (stateOf(backend, created.id) === 'PAUSED') {
      const paused = backend.container.tasks.get(created.id).task;
      expect(paused.pauseReason).toBe('user');
      expect(paused.running).toBe(false);
      await backend.call('tasks:resume', { id: created.id });
    }
    await untilState(backend, created.id, 'COMPLETED');
    expect(existsSync(join(f.documents, 'Reports', 'note.txt'))).toBe(true);
  });
});

describe('restarting Allaya', () => {
  const dbPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-tasks-db-'));
    scratch.push(dir);
    return join(dir, 'allaya.db');
  };

  it('a task that was running when Allaya closed is paused as interrupted, and resumes where it stopped', async () => {
    const path = dbPath();
    const first = await rig(
      {
        plan: [twoStepPlan()],
        steps: {
          s1: [
            aiTurn(aiCall('create_folder', { path: 'Documents/Reports' })),
            aiStepDone('Created the Reports folder.'),
          ],
          s2: ['hang'],
        },
      },
      { databasePath: path },
    );
    const created = await create(first.backend, TWO_STEPS);
    await vi.waitFor(() => expect(first.ai.calls.some((c) => c.stepId === 's2')).toBe(true), {
      timeout: 5000,
    });
    first.backend.dispose();
    backends.splice(backends.indexOf(first.backend), 1);

    // Closing Allaya itself recorded the task as interrupted — it does not rely on finding it half-done later.
    const onDisk = openDatabase({
      path,
      migrationsFolder: sourceMigrationsFolder(),
      readonly: true,
    });
    const closed = onDisk.raw.prepare('select state, runtime_json as runtime from tasks').get() as {
      state: string;
      runtime: string;
    };
    onDisk.close();
    expect(closed.state).toBe('PAUSED');
    expect(JSON.parse(closed.runtime)).toMatchObject({
      pauseReason: 'interrupted',
      pausedFrom: 'EXECUTING',
    });

    // A new session on the same database.
    const second = await rig(
      {
        steps: {
          s2: [
            aiTurn(aiCall('write_file', { path: 'Documents/Reports/note.txt', content: 'hello' })),
            aiStepDone('Saved note.txt.'),
          ],
        },
        summary: [aiFinish('achieved', 'Done after the restart.')],
      },
      { databasePath: path },
    );
    const listed = data<TaskSummary[]>(await second.backend.call('tasks:list'));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      state: 'PAUSED',
      pauseReason: 'interrupted',
      running: false,
      stepCount: 2,
      stepsDone: 1,
    });
    // Nothing ran by itself.
    expect(second.ai.calls).toEqual([]);

    await second.backend.call('tasks:resume', { id: created.id });
    await untilState(second.backend, created.id, 'COMPLETED');
    expect(readFileSync(join(second.fx.documents, 'Reports', 'note.txt'), 'utf8')).toBe('hello');
    // Step one was not done again.
    expect(second.ai.calls.filter((c) => c.kind === 'step').map((c) => c.stepId)).toEqual([
      's2',
      's2',
    ]);
    // The interrupted step was told it might be part-done.
    const brief = JSON.stringify(second.ai.calls[0]!.request.body);
    expect(brief).toMatch(/interrupted earlier/);
  });

  it('after a crash (no orderly shutdown) a half-done task is found and paused, never resumed by itself', async () => {
    const path = dbPath();
    const first = await rig(
      {
        plan: [twoStepPlan()],
        steps: {
          s1: [
            aiTurn(aiCall('create_folder', { path: 'Documents/Reports' })),
            aiStepDone('Created the Reports folder.'),
          ],
          s2: ['hang'],
        },
      },
      { databasePath: path },
    );
    const created = await create(first.backend, TWO_STEPS);
    await vi.waitFor(() => expect(first.ai.calls.some((c) => c.stepId === 's2')).toBe(true), {
      timeout: 5000,
    });
    // What a crash leaves on disk: a copy of the database while the task is mid-step.
    const crashed = join(scratchDir(), 'crashed.db');
    await first.backend.container.database.raw.backup(crashed);
    const snapshot = openDatabase({
      path: crashed,
      migrationsFolder: sourceMigrationsFolder(),
      readonly: true,
    });
    const row = snapshot.raw.prepare('select state from tasks').get() as { state: string };
    snapshot.close();
    expect(row.state).toBe('EXECUTING');

    const second = await rig({}, { databasePath: crashed });
    const listed = data<TaskSummary[]>(await second.backend.call('tasks:list'));
    expect(listed[0]).toMatchObject({ state: 'PAUSED', pauseReason: 'interrupted' });
    expect(second.ai.calls).toEqual([]);
    const d = await detail(second.backend, created.id);
    expect(d.steps.map((s) => s.state)).toEqual(['done', 'pending']);
    expect(d.events.map((e) => e.type)).toContain('INTERRUPTED');
  });

  it('keeps a task that is waiting for the person exactly as it was', async () => {
    const path = dbPath();
    const first = await rig({ plan: [twoStepPlan()] }, { databasePath: path });
    const created = await create(first.backend, TWO_STEPS, true);
    await untilState(first.backend, created.id, 'WAITING_FOR_USER');
    first.backend.dispose();
    backends.splice(backends.indexOf(first.backend), 1);

    const second = await rig(happyScript(), { databasePath: path });
    const listed = data<TaskSummary[]>(await second.backend.call('tasks:list'));
    expect(listed[0]).toMatchObject({
      state: 'WAITING_FOR_USER',
      pending: { kind: 'plan_approval' },
    });
    await second.backend.call('tasks:approve', { id: created.id });
    await untilState(second.backend, created.id, 'COMPLETED');
  });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'allaya-tasks-crash-'));
  scratch.push(dir);
  return dir;
}
