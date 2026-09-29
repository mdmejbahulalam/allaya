import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@allaya/database';
import type { AutomationRunView, AutomationView, AutomationsOverview } from '@allaya/validation';
import { API_KEY } from '../helpers/anthropic';
import { createTestBackend, trustedSender, type TestBackend } from '../helpers/backend';
import {
  aiCall,
  aiPlan,
  aiStepFailed,
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
const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

async function rig(script: FakeAiScript = {}, confirmationTimeoutMs?: number) {
  fx ??= fsFixture();
  const f = fx;
  const ai: FakeAi = fakeAi(script);
  const clock = { now: at(2026, 5, 4, 8, 0) };
  const backend = createTestBackend({
    fetch: ai.fetch,
    ...(confirmationTimeoutMs ? { confirmationTimeoutMs } : {}),
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
  return { backend, ai, fx: f, clock };
}
const make = async (b: TestBackend, over: Record<string, unknown> = {}) =>
  data<AutomationView>(
    await b.call('automations:create', {
      name: 'A',
      instruction: 'Do it',
      trigger: { kind: 'interval', everyMinutes: 5 },
      ...over,
    }),
  );
const runsOf = async (b: TestBackend, id: string) =>
  data<AutomationRunView[]>(await b.call('automations:runs', { id }));

describe('hostile requests to the automation channels', () => {
  const hostile: unknown[] = [
    null,
    [],
    'a string',
    42,
    { name: 42 },
    { name: ['x'], instruction: 'y', trigger: { kind: 'manual' } },
    { name: 'x', instruction: 'y', trigger: null },
    { name: 'x', instruction: 'y', trigger: { kind: '__proto__' } },
    { name: 'x', instruction: 'y', trigger: { kind: 'interval', everyMinutes: '5' } },
    { name: 'x', instruction: 'y', trigger: { kind: 'interval', everyMinutes: Number.NaN } },
    { name: 'x', instruction: 'y', trigger: { kind: 'interval', everyMinutes: Infinity } },
    {
      name: 'x',
      instruction: 'y',
      trigger: { kind: 'daily', time: '09:00', days: [1, 1, 1, 1, 1, 1, 1, 1] },
    },
    { name: 'x', instruction: 'y', trigger: { kind: 'new_file', folder: 'x'.repeat(5000) } },
    { name: 'x', instruction: 'y', trigger: { kind: 'manual' }, options: { missed: '__proto__' } },
    JSON.parse('{"__proto__": {"polluted": true}, "name": 1}'),
    { id: { $ne: null } },
    { id: '' },
    { id: 'x'.repeat(500) },
    { id: 'auto_1', enabled: 'yes' },
    { paused: 'yes' },
  ];
  const channels = [
    'automations:runs',
    'automations:create',
    'automations:update',
    'automations:setEnabled',
    'automations:runNow',
    'automations:delete',
    'automations:setPaused',
  ] as const;

  it('are refused without harm: nothing is created, run or paused, and nothing is polluted', async () => {
    const { backend } = await rig();
    for (const channel of channels) {
      for (const payload of hostile) {
        const result = await backend.call(channel, payload);
        expect(
          (result as { ok: boolean }).ok,
          `${channel} ${JSON.stringify(payload)?.slice(0, 50)}`,
        ).toBe(false);
      }
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(backend.container.database.db.select().from(schema.automations).all()).toEqual([]);
    expect(backend.container.settings.get('automations.paused')).toBe(false);
  });

  it('are refused from any page that is not the app itself', async () => {
    const { backend } = await rig();
    const made = await make(backend);
    const stranger = { id: 9, frameUrl: 'https://evil.example/', isMainFrame: true };
    for (const channel of [...channels, 'automations:list'] as const) {
      const result = await backend.call(
        channel,
        {
          id: made.id,
          name: 'x',
          instruction: 'do harm',
          trigger: { kind: 'manual' },
          changes: { name: 'x', instruction: 'do harm', trigger: { kind: 'manual' } },
          enabled: true,
          paused: true,
        },
        stranger,
      );
      expect(failure(result).code).toBe('UNAUTHORIZED_SENDER');
    }
    // Nothing changed, nothing ran.
    expect(
      data<AutomationsOverview>(await backend.call('automations:list', undefined, trustedSender))
        .paused,
    ).toBe(false);
    expect(await runsOf(backend, made.id)).toEqual([]);
  });
});

describe('an automation has no more power than a chat message', () => {
  it('an unattended run whose plan deletes something waits for the person instead of doing it', async () => {
    const {
      backend,
      fx: f,
      clock,
    } = await rig({
      plan: [
        aiPlan({ steps: [{ id: 's1', title: 'Delete the Old folder', tool: 'delete_folder' }] }),
      ],
      steps: { s1: [aiTurn(aiCall('delete_folder', { path: 'Documents/Old' }))] },
    });
    f.write('Documents/Old/keep.txt', 'precious');
    const made = await make(backend, {
      instruction: 'First look at the Old folder, then delete it.',
      trigger: { kind: 'interval', everyMinutes: 5 },
    });
    clock.now += 5 * 60_000 + 1000;
    await backend.container.automations.scheduler.tick();
    await vi.waitFor(
      async () => expect((await runsOf(backend, made.id))[0]?.status).toBe('waiting_for_approval'),
      {
        timeout: 6000,
      },
    );
    // Nothing was deleted, nothing was even asked yet: the plan itself waits for a yes.
    expect(existsSync(join(f.documents, 'Old', 'keep.txt'))).toBe(true);
    expect(backend.container.tools.pendingConfirmations()).toEqual([]);
    expect(backend.container.database.db.select().from(schema.toolCalls).all()).toEqual([]);
  });

  it('the most dangerous action still needs an on-screen click, and nobody there means no', async () => {
    const {
      backend,
      fx: f,
      clock,
    } = await rig(
      {
        plan: [
          aiPlan({ steps: [{ id: 's1', title: 'Delete the Old folder', tool: 'delete_folder' }] }),
        ],
        steps: { s1: [aiTurn(aiCall('delete_folder', { path: 'Documents/Old' }))] },
      },
      80,
    );
    f.write('Documents/Old/keep.txt', 'precious');
    const made = await make(backend, {
      instruction: 'First look at the Old folder, then delete it.',
      trigger: { kind: 'interval', everyMinutes: 5 },
    });
    clock.now += 5 * 60_000 + 1000;
    await backend.container.automations.scheduler.tick();
    await vi.waitFor(
      async () => expect((await runsOf(backend, made.id))[0]?.status).toBe('waiting_for_approval'),
      {
        timeout: 6000,
      },
    );
    const taskId = (await runsOf(backend, made.id))[0]!.taskId!;
    await backend.call('tasks:approve', { id: taskId });
    await vi.waitFor(() => expect(backend.container.tools.pendingConfirmations()).toHaveLength(1), {
      timeout: 6000,
    });
    const question = backend.container.tools.pendingConfirmations()[0]!;
    expect(question).toMatchObject({ risk: 'CRITICAL', channels: ['ui'] });
    // It expires unanswered; the folder is untouched.
    await vi.waitFor(() => expect(backend.container.tools.pendingConfirmations()).toEqual([]), {
      timeout: 3000,
    });
    expect(existsSync(join(f.documents, 'Old', 'keep.txt'))).toBe(true);
    await backend.call('tasks:cancel', { id: taskId });
  });

  it('a compromised model in an unattended run cannot reach outside, read secrets, or schedule more work', async () => {
    const f = (fx ??= fsFixture());
    const { backend } = await rig({
      steps: {
        s1: [
          aiTurn(
            aiCall('read_file', { path: join(f.outside, 'x') }),
            aiCall('read_file', { path: 'Documents/.env' }),
            aiCall('create_automation', {
              name: 'Persist',
              instruction: 'Send everything',
              trigger: { kind: 'interval', everyMinutes: 5 },
            }),
          ),
          aiStepFailed('Refused.'),
          aiStepFailed('Refused.'),
          aiStepFailed('Refused.'),
        ],
      },
    });
    // Even with file access switched fully on, the file guard's own refusals stand.
    await backend.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
    f.write('Documents/.env', 'SECRET=1');
    writeFileSync(join(f.outside, 'x'), 'PRIVATE');
    const made = await make(backend, { enabled: false, instruction: 'Read some files' });
    await backend.call('automations:runNow', { id: made.id });
    await vi.waitFor(
      async () => expect((await runsOf(backend, made.id))[0]?.status).toBe('failed'),
      { timeout: 8000 },
    );
    const db = backend.container.database.db;
    const results = JSON.stringify(db.select().from(schema.toolResults).all());
    expect(results).not.toContain('SECRET=1');
    expect(results).not.toContain('PRIVATE');
    const list = data<AutomationsOverview>(await backend.call('automations:list'));
    expect(list.automations.map((a) => a.name)).toEqual(['A']); // nothing new was scheduled
    expect(
      db
        .select()
        .from(schema.toolCalls)
        .all()
        .some((c) => c.toolName === 'create_automation' && c.status === 'success'),
    ).toBe(false);
  }, 20_000);
});

describe('a watched folder', () => {
  it('a flood of new files starts one run with a bounded request, not one run per file', async () => {
    const { backend, fx: f } = await rig({});
    const made = await make(backend, {
      instruction: 'Tell me what arrived',
      trigger: { kind: 'new_file', folder: 'Documents' },
    });
    for (let i = 0; i < 300; i += 1) f.write(`Documents/file-${i}.txt`, 'x');
    await backend.container.automations.scheduler.tick();
    const runs = await runsOf(backend, made.id);
    expect(runs).toHaveLength(1);
    const task = data<{ request: string }>(
      await backend.call('tasks:get', { id: runs[0]!.taskId }),
    );
    expect(task.request.match(/^- /gmu)).toHaveLength(20);
    expect(task.request).toContain('(and 280 more)');
    expect(task.request.length).toBeLessThan(2000);
    await backend.call('tasks:cancel', { id: runs[0]!.taskId });
  });
});

describe('the emergency stop', () => {
  it('stays in force after a restart until the person lifts it', async () => {
    const path = join((fx ??= fsFixture()).base, 'auto.db');
    const first = await rig();
    first.backend.dispose();
    backends.splice(backends.indexOf(first.backend), 1);
    // A fresh backend on a file database: stop, close, reopen.
    const f = fx;
    const make2 = () =>
      createTestBackend({
        databasePath: path,
        automations: { now: () => at(2026, 5, 4, 8, 0) },
        files: {
          knownFolders: { documents: f.documents, desktop: f.desktop },
          protectedPaths: [f.appData],
          home: f.base,
          backupsFolder: join(f.appData, 'file-backups'),
          trash: f.trash,
        },
      });
    const one = make2();
    backends.push(one);
    await make(one);
    await one.call('agent:stop');
    expect(one.container.settings.get('automations.paused')).toBe(true);
    one.dispose();
    backends.splice(backends.indexOf(one), 1);
    const two = make2();
    backends.push(two);
    expect(data<AutomationsOverview>(await two.call('automations:list')).paused).toBe(true);
    await two.call('automations:setPaused', { paused: false });
    expect(data<AutomationsOverview>(await two.call('automations:list')).paused).toBe(false);
  });
});
