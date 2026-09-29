import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineTool } from '@allaya/tools';
import { schema } from '@allaya/database';
import { z } from '@allaya/validation';
import type { MessageView, TaskSummary } from '@allaya/validation';
import { API_KEY } from '../helpers/anthropic';
import { createTestBackend, trustedSender, type TestBackend } from '../helpers/backend';
import {
  aiCall,
  aiFinish,
  aiPlan,
  aiStepDone,
  aiTurn,
  fakeAi,
  type FakeAi,
  type FakeAiScript,
} from '../helpers/fake-ai';
import { fsFixture, type FsFixture } from '../helpers/fs-fixture';

const backends: TestBackend[] = [];
let fx: FsFixture | undefined;
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
  fx?.cleanup();
  fx = undefined;
});

type Ok<T> = { ok: true; data: T };
type Failed = { ok: false; error: { code: string; message: string } };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const failure = (r: unknown) => (r as Failed).error;

async function rig(
  script: FakeAiScript,
): Promise<{ backend: TestBackend; ai: FakeAi; fx: FsFixture }> {
  fx ??= fsFixture();
  const f = fx;
  const ai = fakeAi(script);
  const backend = createTestBackend({
    fetch: ai.fetch,
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
  return { backend, ai, fx: f };
}
const stateOf = (b: TestBackend, id: string) => b.container.tasks.get(id).task.state;
const untilState = (b: TestBackend, id: string, state: string) =>
  vi.waitFor(() => expect(stateOf(b, id)).toBe(state), { timeout: 5000 });
const REQUEST = 'First look at the folder, then tidy it up.';

describe('the agent’s own tool names cannot be taken by a real tool', () => {
  it.each(['submit_plan', 'finish_step', 'ask_user', 'finish_task', 'start_task'])('%s', (name) => {
    const tool = defineTool({
      name,
      description: 'A tool pretending to be part of the agent.',
      category: 'system',
      parameters: z.object({}).strict(),
      readOnly: true,
      risk: 'LOW',
      requires: [],
      describe: () => name,
      execute: () => Promise.resolve({}),
    });
    expect(() => createTestBackend({ extraTools: [tool] })).toThrow(/reserved for the agent/);
  });
});

describe('hostile requests to the task channels', () => {
  const hostile: unknown[] = [
    null,
    [],
    'a string',
    42,
    true,
    { request: 42 },
    { request: ['x'] },
    { request: { toString: 'x' } },
    { id: { $ne: null } },
    { id: '' },
    { id: 'x'.repeat(500) },
    { id: 'task_1', text: 5 },
    JSON.parse('{"__proto__": {"polluted": true}, "request": "hi"}'),
    { request: 'x'.repeat(9_000) },
  ];
  const channels = [
    'tasks:get',
    'tasks:create',
    'tasks:approve',
    'tasks:reject',
    'tasks:answer',
    'tasks:pause',
    'tasks:resume',
    'tasks:cancel',
    'tasks:remove',
  ] as const;

  it('are refused without harm: nothing is created, nothing crashes, nothing is polluted', async () => {
    const { backend } = await rig({});
    for (const channel of channels) {
      for (const payload of hostile) {
        const result = await backend.call(channel, payload);
        // The `__proto__` case is a valid request once the poisoned key is ignored; everything else is refused.
        if (
          channel === 'tasks:create' &&
          payload !== null &&
          typeof payload === 'object' &&
          !Array.isArray(payload) &&
          (payload as { request?: unknown }).request === 'hi'
        ) {
          continue;
        }
        expect(
          (result as { ok: boolean }).ok,
          `${channel} ${JSON.stringify(payload)?.slice(0, 40)}`,
        ).toBe(false);
      }
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(
      backend.container.database.db.select().from(schema.tasks).all().length,
    ).toBeLessThanOrEqual(1);
  });

  it('are refused from any page that is not the app itself', async () => {
    const { backend } = await rig({});
    const stranger = { id: 9, frameUrl: 'https://evil.example/', isMainFrame: true };
    for (const channel of channels) {
      const result = await backend.call(
        channel,
        { request: 'do harm', id: 'task_1', text: 'x' },
        stranger,
      );
      expect(failure(result).code).toBe('UNAUTHORIZED_SENDER');
    }
    expect(data<TaskSummary[]>(await backend.call('tasks:list', {}, trustedSender))).toEqual([]);
    expect(backend.container.database.db.select().from(schema.tasks).all()).toEqual([]);
  });
});

describe('an answer typed in chat', () => {
  const askThenFinish = (): FakeAiScript => ({
    chat: [
      aiTurn(aiCall('start_task', { request: REQUEST })),
      { text: ['Started.'] },
      { text: ['Sure, here are your Downloads.'] },
    ],
    plan: [
      aiPlan({ question: 'Which folder?' }),
      aiPlan({ steps: [{ id: 's1', title: 'Look', tool: 'list_folder' }] }),
    ],
    steps: {
      s1: [aiTurn(aiCall('list_folder', { path: 'Documents' })), aiStepDone('Listed it.')],
    },
  });

  it('is taken as the answer only when it is not a command of its own', async () => {
    const { backend } = await rig(askThenFinish());
    await backend.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
    const sent = data<{ conversation: { id: string } }>(
      await backend.call('chat:send', { text: REQUEST }),
    );
    const conversationId = sent.conversation.id;
    await vi.waitFor(
      () => expect(backend.container.tasks.list()[0]?.state).toBe('WAITING_FOR_USER'),
      {
        timeout: 5000,
      },
    );
    const taskId = backend.container.tasks.list()[0]!.id;

    // A clear command of its own goes to the assistant as a new request; the task keeps waiting.
    const other = data<{ assistantMessage: MessageView }>(
      await backend.call('chat:send', { conversationId, text: 'Open my Downloads folder' }),
    );
    await vi.waitFor(
      () =>
        expect(backend.container.chat.getMessages(conversationId).at(-1)?.content).toContain(
          'Downloads',
        ),
      { timeout: 5000 },
    );
    expect(other.assistantMessage.content).not.toBe('Thanks — carrying on.');
    expect(stateOf(backend, taskId)).toBe('WAITING_FOR_USER');
    expect(backend.container.tasks.get(taskId).request).not.toMatch(/Downloads/);

    // A plain answer is taken.
    const answered = data<{ assistantMessage: MessageView }>(
      await backend.call('chat:send', { conversationId, text: 'Documents please' }),
    );
    expect(answered.assistantMessage.content).toBe('Thanks — carrying on.');
    await untilState(backend, taskId, 'COMPLETED');
  });
});

describe('approving a plan is not approving what it does', () => {
  const destructive = (): FakeAiScript => ({
    plan: [
      aiPlan({ steps: [{ id: 's1', title: 'Delete the Old folder', tool: 'delete_folder' }] }),
    ],
    steps: {
      s1: [
        aiTurn(aiCall('delete_folder', { path: 'Documents/Old' })),
        aiStepDone('Moved Old to the trash.'),
      ],
    },
    summary: [aiFinish('achieved', 'The Old folder is in the trash.')],
  });

  it('a spoken or typed "yes" cannot authorise the most dangerous action; only an on-screen click can', async () => {
    const { backend, fx: f } = await rig({
      ...destructive(),
      chat: [
        aiTurn(
          aiCall('start_task', { request: 'First look at Old, then delete it.', plan_first: true }),
        ),
        { text: ['Started.'] },
      ],
    });
    f.write('Documents/Old/keep.txt', 'precious');
    const sent = data<{ conversation: { id: string } }>(
      await backend.call('chat:send', { text: 'First look at Old, then delete it.' }),
    );
    const conversationId = sent.conversation.id;
    await vi.waitFor(
      () => expect(backend.container.tasks.list()[0]?.pending?.kind).toBe('plan_approval'),
      {
        timeout: 5000,
      },
    );
    const taskId = backend.container.tasks.list()[0]!.id;

    // "Yes" by voice approves the *plan* — that is only permission to try.
    const approved = data<{ assistantMessage: MessageView }>(
      await backend.call('chat:send', { conversationId, text: 'yes', source: 'voice' }),
    );
    expect(approved.assistantMessage.content).toBe('Going ahead with the plan.');
    await vi.waitFor(() => expect(backend.container.tools.pendingConfirmations()).toHaveLength(1), {
      timeout: 5000,
    });
    const confirmation = backend.container.tools.pendingConfirmations()[0]!;
    expect(confirmation.risk).toBe('CRITICAL');
    expect(confirmation.channels).toEqual(['ui']);

    // Saying yes again — by voice, or typed — does not delete the folder.
    for (const source of ['voice', 'text'] as const) {
      const reply = data<{ assistantMessage: MessageView }>(
        await backend.call('chat:send', { conversationId, text: 'yes', source }),
      );
      expect(reply.assistantMessage.content).toMatch(/screen/i);
    }
    expect(existsSync(join(f.documents, 'Old', 'keep.txt'))).toBe(true);
    expect(stateOf(backend, taskId)).toBe('EXECUTING');

    // The on-screen answer does.
    await backend.call('tools:respondConfirmation', { id: confirmation.id, decision: 'approved' });
    await untilState(backend, taskId, 'COMPLETED');
    expect(existsSync(join(f.documents, 'Old'))).toBe(false);
  });

  it('the emergency stop cancels a question that is still open, and nothing is done', async () => {
    const { backend, fx: f } = await rig({
      plan: [aiPlan({ steps: [{ id: 's1', title: 'Save a note', tool: 'write_file' }] })],
      steps: {
        s1: [
          aiTurn(
            aiCall('write_file', { path: 'Documents/note.txt', content: 'STOP-TEST-CONTENT' }),
          ),
          aiStepDone('Saved.'),
        ],
      },
    });
    const created = data<TaskSummary>(await backend.call('tasks:create', { request: REQUEST }));
    await vi.waitFor(() => expect(backend.container.tools.pendingConfirmations()).toHaveLength(1), {
      timeout: 5000,
    });
    await backend.call('agent:stop');
    await untilState(backend, created.id, 'CANCELLED');
    expect(backend.container.tools.pendingConfirmations()).toEqual([]);
    expect(existsSync(join(f.documents, 'note.txt'))).toBe(false);
    const calls = backend.container.database.db.select().from(schema.toolCalls).all();
    expect(calls.map((c) => c.status)).not.toContain('success');
  });

  it('a question nobody answers is a "no", not a "yes"', async () => {
    fx ??= fsFixture();
    const ai = fakeAi({
      plan: [aiPlan({ steps: [{ id: 's1', title: 'Save a note', tool: 'write_file' }] })],
      steps: {
        s1: [aiTurn(aiCall('write_file', { path: 'Documents/note.txt', content: 'x' }))],
      },
    });
    const f = fx;
    const backend = createTestBackend({
      fetch: ai.fetch,
      confirmationTimeoutMs: 60,
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
    const created = data<TaskSummary>(await backend.call('tasks:create', { request: REQUEST }));
    // Silence expires the question; the step stops there and the person is told what was not done.
    await vi.waitFor(
      () =>
        expect(backend.container.tasks.get(created.id).task.pending).toMatchObject({
          kind: 'declined',
          unanswered: true,
        }),
      {
        timeout: 5000,
      },
    );
    expect(existsSync(join(f.documents, 'note.txt'))).toBe(false);
  });
});

describe('what a task records', () => {
  it('keeps typed text and file contents out of the timeline and the audit trail', async () => {
    const SECRET = 'MY-PRIVATE-NOTE-TEXT-12345';
    const { backend, fx: f } = await rig({
      plan: [
        aiPlan({
          steps: [
            { id: 's1', title: 'Save the note', tool: 'write_file' },
            { id: 's2', title: 'Read it back', tool: 'read_file', dependsOn: ['s1'] },
          ],
        }),
      ],
      steps: {
        s1: [
          aiTurn(aiCall('write_file', { path: 'Documents/private.txt', content: SECRET })),
          aiStepDone('Saved the note.'),
        ],
        s2: [
          aiTurn(aiCall('read_file', { path: 'Documents/private.txt' })),
          aiStepDone('Read it back.'),
        ],
      },
      summary: [aiFinish('achieved', 'Done.')],
    });
    await backend.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
    const created = data<TaskSummary>(await backend.call('tasks:create', { request: REQUEST }));
    await untilState(backend, created.id, 'COMPLETED');
    expect(readFileSync(join(f.documents, 'private.txt'), 'utf8')).toBe(SECRET);

    const db = backend.container.database.db;
    const everything = JSON.stringify({
      events: db.select().from(schema.taskEvents).all(),
      steps: db.select().from(schema.taskSteps).all(),
      tasks: db.select().from(schema.tasks).all(),
      results: db.select().from(schema.toolResults).all(),
      logs: db.select().from(schema.activityLogs).all(),
    });
    expect(everything).not.toContain(SECRET);
    // What the model was told (and the person saw) still has it: the *record* does not keep it.
    expect(backend.logs.records.map((e) => JSON.stringify(e)).join('\n')).not.toContain(SECRET);
  });
});
