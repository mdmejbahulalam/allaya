import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@allaya/ai';
import { ApprovalService, approverForChat } from '@lite/main/core/approvals';
import { Events } from '@lite/main/core/events';
import { CATCH_UP_MS, MAX_CONCURRENT_RUNS, buildTaskPrompt } from '@lite/main/core/tasks';
import { describeSchedule, scheduleFromArgs } from '@lite/main/core/task-tools';
import type { ChatView, ConnectionView, RunView, TaskView } from '@lite/shared/ipc';
import { API_KEY, HAIKU, SONNET, hangingStream, modelsResponse } from '../helpers/anthropic';
import { aiCall, fakeAi, type FakeAi, type FakeAiScript } from '../helpers/fake-ai';
import { json } from '../helpers/fetch';
import { createLiteBackend, data, failure, type LiteBackend } from './helpers/backend';

const backends: LiteBackend[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const b of backends.splice(0)) b.dispose();
});

let clock: Date;
const at = (h: number, m = 0, d = 10) => new Date(2026, 9, d, h, m, 0, 0);
beforeEach(() => {
  clock = at(8, 0);
});

async function rig(
  script: FakeAiScript = {},
  options: Parameters<typeof createLiteBackend>[0] = {},
) {
  const ai: FakeAi = fakeAi(script);
  const b = createLiteBackend({ fetch: ai.fetch, now: () => clock, ...options });
  backends.push(b);
  const connection = data<ConnectionView>(
    await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY }),
  );
  return {
    b,
    ai,
    connection,
    sonnet: { connectionId: connection.id, modelId: SONNET },
    haiku: { connectionId: connection.id, modelId: HAIKU },
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  title: 'Morning check',
  instructions: 'Look at example.com and tell me the headline.',
  model: null,
  schedule: { kind: 'manual' },
  groups: ['browser'],
  ...over,
});
const create = async (b: LiteBackend, over: Record<string, unknown> = {}) =>
  data<TaskView>(await b.call('tasks:create', input(over) as never));
const body = (call: FakeAi['calls'][number]) =>
  call.request.body as {
    model: string;
    system: string;
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ name: string }>;
  };
const runOf = async (b: LiteBackend, id: string) =>
  data<{ task: TaskView; runs: RunView[] }>(await b.call('tasks:get', { id }));

describe('making a task', () => {
  it('keeps its words, its model, its schedule and what it may use — and shows it newest first', async () => {
    const { b, sonnet } = await rig();
    const first = await create(b, { title: 'One' });
    const second = await create(b, {
      title: 'Two',
      model: sonnet,
      groups: [],
      schedule: { kind: 'every', minutes: 60 },
    });
    expect(second).toMatchObject({
      title: 'Two',
      model: sonnet,
      groups: [],
      createdBy: 'person',
      enabled: true,
      running: false,
      lastRun: null,
    });
    expect(data<TaskView[]>(await b.call('tasks:list')).map((t) => t.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(b.events.of('tasks:changed')).toHaveLength(2);
  });

  it('works out when it runs next', async () => {
    const { b } = await rig();
    expect((await create(b)).nextRunAt).toBeNull();
    expect((await create(b, { schedule: { kind: 'every', minutes: 30 } })).nextRunAt).toBe(
      at(8, 30).getTime(),
    );
    expect(
      (await create(b, { schedule: { kind: 'daily', time: '07:00', days: [] } })).nextRunAt,
    ).toBe(at(7, 0, 11).getTime());
    expect(
      (await create(b, { schedule: { kind: 'daily', time: '09:15', days: [] } })).nextRunAt,
    ).toBe(at(9, 15).getTime());
    expect((await create(b, { schedule: { kind: 'once', at: at(12).getTime() } })).nextRunAt).toBe(
      at(12).getTime(),
    );
  });

  it('refuses a time that has passed, a bad schedule, and a task with nothing in it', async () => {
    const { b } = await rig();
    expect(
      failure(
        await b.call(
          'tasks:create',
          input({ schedule: { kind: 'once', at: at(7).getTime() } }) as never,
        ),
      ).details,
    ).toEqual({ reason: 'in_the_past' });
    for (const bad of [
      { title: '  ' },
      { instructions: '' },
      { schedule: { kind: 'every', minutes: 1 } },
      { schedule: { kind: 'cron' } },
      { title: 'x'.repeat(101) },
    ]) {
      expect(
        failure(await b.call('tasks:create', input(bad) as never)).code,
        JSON.stringify(bad),
      ).toBe('INVALID_IPC_PAYLOAD');
    }
    expect(data<TaskView[]>(await b.call('tasks:list'))).toEqual([]);
  });

  it('changes a task, plans again when its schedule or switch changes, and removes it with its runs', async () => {
    const { b } = await rig({ chat: [{ text: ['Done.'] }] });
    const task = await create(b, { schedule: { kind: 'every', minutes: 60 } });
    expect(task.nextRunAt).toBe(at(9, 0).getTime());
    clock = at(8, 30);
    const renamed = data<TaskView>(
      await b.call('tasks:update', { id: task.id, changes: { title: 'Renamed' } }),
    );
    expect(renamed).toMatchObject({ title: 'Renamed', nextRunAt: at(9, 0).getTime() });
    const replanned = data<TaskView>(
      await b.call('tasks:update', {
        id: task.id,
        changes: { schedule: { kind: 'every', minutes: 10 } },
      }),
    );
    expect(replanned.nextRunAt).toBe(at(8, 40).getTime());
    await b.call('tasks:update', { id: task.id, changes: { enabled: false } });
    clock = at(10, 0);
    const back = data<TaskView>(
      await b.call('tasks:update', { id: task.id, changes: { enabled: true } }),
    );
    expect(back).toMatchObject({ enabled: true, nextRunAt: at(10, 10).getTime() });
    await b.call('tasks:run', { id: task.id });
    await b.tasks.whenIdle();
    expect(data(await b.call('tasks:remove', { id: task.id }))).toEqual({ ok: true });
    expect(b.db.prepare('select count(*) as n from task_runs').get()).toEqual({ n: 0 });
    expect(failure(await b.call('tasks:get', { id: task.id })).code).toBe('NOT_FOUND');
  });

  it('allows only a hundred', async () => {
    const { b } = await rig();
    for (let i = 0; i < 100; i += 1) b.tasks.create(input({ title: `T${i}` }) as never);
    expect(failure(await b.call('tasks:create', input() as never)).details).toEqual({
      reason: 'too_many',
    });
  });
});

describe('running a task', () => {
  it('runs it with its own model, and keeps a report with the steps it took', async () => {
    const { b, ai, haiku } = await rig({
      chat: [
        { text: ['Checking. '], calls: [aiCall('open_url', { url: 'https://example.com/' })] },
        { calls: [aiCall('read_page', {})] },
        { text: ['Headline: Example Domain.'] },
      ],
    });
    b.browser.pages.set('https://example.com/', {
      title: 'Example Domain',
      text: 'This domain is for use in examples.',
    });
    const task = await create(b, { model: haiku });
    const started = data<RunView>(await b.call('tasks:run', { id: task.id }));
    expect(started).toMatchObject({
      status: 'running',
      trigger: 'manual',
      taskTitle: 'Morning check',
      model: 'Claude Haiku 4.5',
    });
    expect(data<TaskView[]>(await b.call('tasks:list'))[0]!.running).toBe(true);
    await b.tasks.whenIdle();
    const { task: after, runs } = await runOf(b, task.id);
    expect(after.running).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'done',
      result: 'Checking. \n\nHeadline: Example Domain.',
      model: 'Claude Haiku 4.5',
    });
    expect(runs[0]!.finishedAt).toBeGreaterThan(0);
    expect(runs[0]!.steps.map((s) => s.tool)).toEqual(['open_url', 'read_page']);
    expect(after.lastRun!.id).toBe(runs[0]!.id);
    // It used the model chosen for this task.
    expect(ai.calls.every((c) => body(c).model === HAIKU)).toBe(true);
    // The person is told it ended; the screen was told as it went.
    expect(b.finished).toHaveLength(1);
    expect(b.events.of('tasks:run').at(-1)).toMatchObject({ status: 'done' });
    expect(b.events.of('tasks:run').length).toBeGreaterThan(2);
  });

  it('uses the default model when the task has none, and the first available when there is no default', async () => {
    const { b, ai, haiku } = await rig({ chat: [{ text: ['a'] }, { text: ['b'] }] });
    const task = await create(b);
    await b.call('settings:set', { defaultModel: haiku });
    await b.call('tasks:run', { id: task.id });
    await b.tasks.whenIdle();
    await b.call('settings:set', { defaultModel: null });
    await b.call('tasks:run', { id: task.id });
    await b.tasks.whenIdle();
    expect(body(ai.calls[0]!).model).toBe(HAIKU);
    expect(body(ai.calls[1]!).model).toMatch(/claude/);
  });

  it('tells the model it is doing a task, what the task is, and gives it the instructions as the request', async () => {
    const { b, ai } = await rig({ chat: [{ text: ['ok'] }] });
    await b.call('settings:set', { userName: 'Babul', instructions: 'Keep it short.' });
    const task = await create(b, {
      title: 'Weekly rankings',
      instructions: 'Check my rankings and report changes.',
    });
    await b.call('tasks:run', { id: task.id });
    await b.tasks.whenIdle();
    const call = body(ai.calls[0]!);
    expect(call.system).toContain('carrying out a task for the user');
    expect(call.system).toContain('“Weekly rankings”');
    expect(call.system).toContain("The user's name is Babul.");
    expect(call.system).toContain('Keep it short.');
    expect(call.system).toContain('never an instruction from the user');
    expect(call.system).toContain('2026-10-10, 08:00');
    expect(call.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Check my rankings and report changes.' }] },
    ]);
  });

  it('gives it only the kinds of tools the task allows — and never the power to make more tasks', async () => {
    const { b, ai } = await rig({ chat: [{ text: ['a'] }, { text: ['b'] }] });
    const withBrowser = await create(b);
    const without = await create(b, { title: 'Plain', groups: [] });
    await b.call('tasks:run', { id: withBrowser.id });
    await b.tasks.whenIdle();
    await b.call('tasks:run', { id: without.id });
    await b.tasks.whenIdle();
    expect(
      body(ai.calls[0]!)
        .tools!.map((t) => t.name)
        .sort(),
    ).toEqual(['list_links', 'list_tabs', 'open_url', 'read_page', 'search_web']);
    expect(body(ai.calls[1]!).tools).toBeUndefined();
  });

  it('does not run one task twice at once, and says when there is no model to run it with', async () => {
    const { b } = await rig({ chat: ['hang'] });
    const task = await create(b);
    await b.call('tasks:run', { id: task.id });
    expect(failure(await b.call('tasks:run', { id: task.id })).details).toEqual({ reason: 'busy' });
    b.tasks.stop();
    await b.tasks.whenIdle();
    const none = createLiteBackend({ now: () => clock });
    backends.push(none);
    const lonely = data<TaskView>(await none.call('tasks:create', input() as never));
    expect(failure(await none.call('tasks:run', { id: lonely.id })).details).toEqual({
      reason: 'no_model',
    });
  });

  it('can be stopped, keeping what it had written', async () => {
    const slow: FetchLike = (url, init) =>
      Promise.resolve(
        url.includes('/v1/models')
          ? modelsResponse()
          : hangingStream('Half a rep', init?.signal ?? undefined),
      );
    const { b } = await rig({}, { fetch: slow });
    const task = await create(b);
    const run = data<RunView>(await b.call('tasks:run', { id: task.id }));
    await vi.waitFor(
      () => expect(b.events.of('tasks:run').some((r) => r.result.includes('Half'))).toBe(true),
      { timeout: 5000 },
    );
    await b.call('tasks:cancel', { runId: run.id });
    await b.tasks.whenIdle();
    expect((await runOf(b, task.id)).runs[0]).toMatchObject({
      status: 'cancelled',
      result: 'Half a rep',
    });
  });

  it('says what went wrong when it fails, and when the model gave nothing', async () => {
    const bad: FetchLike = (url) =>
      Promise.resolve(
        url.includes('/v1/models')
          ? modelsResponse()
          : json({ error: { message: `bad key ${API_KEY}` } }, { status: 401 }),
      );
    const failing = await rig({}, { fetch: bad });
    const task = await create(failing.b);
    await failing.b.call('tasks:run', { id: task.id });
    await failing.b.tasks.whenIdle();
    const run = (await runOf(failing.b, task.id)).runs[0]!;
    expect(run).toMatchObject({ status: 'error', error: { code: 'PROVIDER_AUTH_FAILED' } });
    expect(JSON.stringify(run)).not.toContain(API_KEY);

    const quiet = await rig({ chat: [{ text: [] }] });
    const t2 = await create(quiet.b);
    await quiet.b.call('tasks:run', { id: t2.id });
    await quiet.b.tasks.whenIdle();
    expect((await runOf(quiet.b, t2.id)).runs[0]).toMatchObject({
      status: 'error',
      error: { code: 'PROVIDER_ERROR' },
    });
  });

  it('a run that was going when the app closed is shown as stopped, not as still going', async () => {
    const { b } = await rig();
    const task = await create(b);
    b.db
      .prepare(
        `insert into task_runs (id, task_id, trigger, status, model, started_at) values ('r1', ?, 'manual', 'running', 'm', 5)`,
      )
      .run(task.id);
    b.tasks.recoverInterrupted();
    expect((await runOf(b, task.id)).runs[0]).toMatchObject({
      status: 'cancelled',
      error: { message: 'The app was closed while this ran.' },
    });
  });

  it('a task that asks to change something outside waits for the person, and is told no if the answer is no', async () => {
    const { b } = await rig({
      chat: [{ calls: [aiCall('post', { text: 'hello' })] }, { text: ['I could not post.'] }],
    });
    b.tools.register({
      name: 'post',
      effect: 'write',
      description: 'Post',
      inputSchema: { type: 'object', properties: {} },
      summarize: (a) => `Post: ${String(a['text'])}`,
      run: () => Promise.resolve('Posted.'),
    });
    const task = await create(b, { groups: [] });
    await b.call('tasks:run', { id: task.id });
    await vi.waitFor(() => expect(b.approvals.list()).toHaveLength(1));
    expect(b.approvals.list()[0]).toMatchObject({
      summary: 'Post: hello',
      source: { kind: 'task', taskId: task.id, taskTitle: 'Morning check' },
    });
    b.approvals.decide(b.approvals.list()[0]!.id, false);
    await b.tasks.whenIdle();
    expect((await runOf(b, task.id)).runs[0]!.steps[0]).toMatchObject({ status: 'denied' });
  });
});

describe('the clock', () => {
  const dueTask = async (b: LiteBackend, over: Record<string, unknown> = {}) =>
    create(b, { schedule: { kind: 'every', minutes: 60 }, ...over });

  it('runs what is due, once, and not before it is due', async () => {
    const { b, ai } = await rig({ chat: [{ text: ['one'] }, { text: ['two'] }] });
    await dueTask(b);
    b.tasks.tick();
    await b.tasks.whenIdle();
    expect(ai.calls).toHaveLength(0);
    clock = at(9, 0);
    b.tasks.tick();
    b.tasks.tick();
    await b.tasks.whenIdle();
    expect(ai.calls).toHaveLength(1);
    expect(b.finished[0]).toMatchObject({ trigger: 'schedule', status: 'done' });
    // Planned for an hour after it started.
    expect(data<TaskView[]>(await b.call('tasks:list'))[0]!.nextRunAt).toBe(at(10, 0).getTime());
  });

  it('leaves alone what is switched off, run by hand, or already finished', async () => {
    const { b, ai } = await rig({ chat: [{ text: ['x'] }] });
    await dueTask(b, { enabled: false });
    await create(b, { schedule: { kind: 'manual' } });
    clock = at(12, 0);
    b.tasks.tick();
    await b.tasks.whenIdle();
    expect(ai.calls).toHaveLength(0);
  });

  it('runs a one-time task at its time and then never again', async () => {
    const { b, ai } = await rig({ chat: [{ text: ['once'] }, { text: ['twice'] }] });
    const task = await create(b, { schedule: { kind: 'once', at: at(9, 0).getTime() } });
    clock = at(9, 1);
    b.tasks.tick();
    await b.tasks.whenIdle();
    expect(ai.calls).toHaveLength(1);
    expect((await runOf(b, task.id)).task.nextRunAt).toBeNull();
    clock = at(23, 0);
    b.tasks.tick();
    await b.tasks.whenIdle();
    expect(ai.calls).toHaveLength(1);
  });

  it('a repeating task missed while the app was closed is run once, not once for every missed time', async () => {
    const { b, ai } = await rig({ chat: [{ text: ['a'] }, { text: ['b'] }] });
    await dueTask(b, { schedule: { kind: 'every', minutes: 10 } });
    clock = at(20, 0); // twelve hours later: dozens of missed runs
    b.tasks.tick();
    await b.tasks.whenIdle();
    expect(ai.calls).toHaveLength(1);
    b.tasks.tick();
    await b.tasks.whenIdle();
    expect(ai.calls).toHaveLength(1);
  });

  it('a repeating task missed for more than a day is not run late; it waits for its next time', async () => {
    const { b, ai } = await rig({ chat: [{ text: ['late'] }] });
    const task = await create(b, { schedule: { kind: 'daily', time: '08:30', days: [] } });
    clock = new Date(clock.getTime() + CATCH_UP_MS + 3 * 3_600_000);
    b.tasks.tick();
    await b.tasks.whenIdle();
    expect(ai.calls).toHaveLength(0);
    const next = (await runOf(b, task.id)).task.nextRunAt!;
    expect(next).toBeGreaterThan(clock.getTime());
  });

  it('runs only so many at once, and starts the next as soon as one ends', async () => {
    const releases: Array<() => void> = [];
    let started = 0;
    const gated: FetchLike = async (url) => {
      if (url.includes('/v1/models')) return modelsResponse();
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return fakeAi({ chat: [{ text: ['ok'] }] }).fetch(url);
    };
    const { b } = await rig({}, { fetch: gated });
    for (let i = 0; i < MAX_CONCURRENT_RUNS + 1; i += 1) await dueTask(b, { title: `T${i}` });
    clock = at(9, 0);
    b.tasks.tick();
    await vi.waitFor(() => expect(started).toBe(MAX_CONCURRENT_RUNS));
    expect(data<TaskView[]>(await b.call('tasks:list')).filter((t) => t.running)).toHaveLength(
      MAX_CONCURRENT_RUNS,
    );
    releases.shift()!();
    await vi.waitFor(() => expect(started).toBe(MAX_CONCURRENT_RUNS + 1));
    for (const release of releases) release();
    await b.tasks.whenIdle();
    expect(b.finished).toHaveLength(MAX_CONCURRENT_RUNS + 1);
  });

  it('plans the next run from when a long run started, not from when it ended', async () => {
    let release: () => void = () => undefined;
    let waiting = false;
    const gated: FetchLike = async (url) => {
      if (url.includes('/v1/models')) return modelsResponse();
      waiting = true;
      await new Promise<void>((resolve) => (release = resolve));
      return fakeAi({ chat: [{ text: ['ok'] }] }).fetch(url);
    };
    const { b } = await rig({}, { fetch: gated });
    const task = await dueTask(b);
    clock = at(9, 0);
    b.tasks.tick();
    await vi.waitFor(() => expect(waiting).toBe(true));
    expect((await runOf(b, task.id)).task.running).toBe(true);
    clock = at(9, 20);
    release();
    await b.tasks.whenIdle();
    expect((await runOf(b, task.id)).task.nextRunAt).toBe(at(10, 0).getTime());
  });

  it('shows a run that was going when the app last closed as stopped, as soon as the clock starts', async () => {
    const { b } = await rig();
    const task = await create(b);
    b.db
      .prepare(
        `insert into task_runs (id, task_id, trigger, status, model, started_at) values ('r1', ?, 'manual', 'running', 'm', 5)`,
      )
      .run(task.id);
    b.tasks.start();
    b.tasks.stop();
    expect((await runOf(b, task.id)).runs[0]).toMatchObject({ status: 'cancelled' });
  });

  it('a scheduled run that cannot even start is recorded, and not tried again every half minute', async () => {
    const b = createLiteBackend({ now: () => clock });
    backends.push(b);
    const task = data<TaskView>(
      await b.call('tasks:create', input({ schedule: { kind: 'every', minutes: 60 } }) as never),
    );
    clock = at(9, 0);
    b.tasks.tick();
    await vi.waitFor(() => expect(b.finished).toHaveLength(1));
    expect(b.finished[0]).toMatchObject({
      status: 'error',
      error: { code: 'PROVIDER_NOT_CONFIGURED' },
    });
    b.tasks.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(b.finished).toHaveLength(1);
    expect((await runOf(b, task.id)).task.nextRunAt).toBe(at(10, 0).getTime());
  });
});

describe('Allaya making a task in a chat', () => {
  const args = {
    title: 'Morning rankings',
    instructions: 'Check example.com and report the headline.',
    when: 'daily',
    time: '08:30',
    days: ['Monday', 'friday'],
    model_need: 'fast',
  };

  async function ask(script: FakeAiScript) {
    const r = await rig(script);
    const sent = data<{ chat: ChatView }>(
      await r.b.call('chat:send', {
        text: 'Every Monday and Friday morning, check example.com',
        model: r.sonnet,
      }),
    );
    return { ...r, chat: sent.chat };
  }

  it('asks first, in plain words, and makes the task only after a yes — with a model that fits', async () => {
    const r = await ask({
      chat: [{ calls: [aiCall('create_task', args)] }, { text: ['I set that up.'] }],
    });
    await vi.waitFor(() => expect(r.b.approvals.list()).toHaveLength(1));
    expect(r.b.approvals.list()[0]!.summary).toBe(
      'Create the task “Morning rankings” — Monday, Friday at 08:30',
    );
    expect(data<TaskView[]>(await r.b.call('tasks:list'))).toEqual([]);
    r.b.approvals.decide(r.b.approvals.list()[0]!.id, true);
    await r.b.chat.whenIdle();
    const [task] = data<TaskView[]>(await r.b.call('tasks:list'));
    expect(task).toMatchObject({
      title: 'Morning rankings',
      createdBy: 'allaya',
      model: { connectionId: r.connection.id, modelId: HAIKU },
      schedule: { kind: 'daily', time: '08:30', days: [1, 5] },
      groups: ['browser'],
    });
  });

  it('makes nothing when the answer is no, and the model is told', async () => {
    const r = await ask({
      chat: [{ calls: [aiCall('create_task', args)] }, { text: ['Understood.'] }],
    });
    await vi.waitFor(() => expect(r.b.approvals.list()).toHaveLength(1));
    r.b.approvals.decide(r.b.approvals.list()[0]!.id, false);
    await r.b.chat.whenIdle();
    expect(data<TaskView[]>(await r.b.call('tasks:list'))).toEqual([]);
    expect(JSON.stringify(r.ai.calls[1]!.request.body)).toContain('did not allow');
  });

  it('refuses unclear instructions in a way the model can read, without asking the person to approve nonsense first', async () => {
    const r = await ask({
      chat: [
        { calls: [aiCall('create_task', { ...args, when: 'sometimes' })] },
        { text: ['Sorry.'] },
      ],
    });
    await r.b.chat.whenIdle();
    // Nobody was asked; the model was told what to fix.
    expect(r.b.approvals.list()).toEqual([]);
    expect(data<TaskView[]>(await r.b.call('tasks:list'))).toEqual([]);
    expect(JSON.stringify(r.ai.calls[1]!.request.body)).toContain(
      'must be one of: manual, once, every, daily',
    );
  });

  it('does not ask about a time that has already passed, or an empty task', async () => {
    for (const bad of [
      { ...args, when: 'once', at: '2001-01-01T09:00' },
      { ...args, instructions: '   ' },
    ]) {
      const r = await ask({
        chat: [{ calls: [aiCall('create_task', bad)] }, { text: ['Let me fix that.'] }],
      });
      await r.b.chat.whenIdle();
      expect(r.b.approvals.list()).toEqual([]);
      expect(data<TaskView[]>(await r.b.call('tasks:list'))).toEqual([]);
      expect(JSON.stringify(r.ai.calls[1]!.request.body)).toMatch(/passed|needs a title/);
    }
  });

  it('can list the tasks, which only looks', async () => {
    const r = await rig({
      chat: [{ calls: [aiCall('list_tasks', {})] }, { text: ['You have one.'] }],
    });
    await create(r.b, { title: 'Daily brief', schedule: { kind: 'every', minutes: 120 } });
    await r.b.call('chat:send', { text: 'What tasks do I have?', model: r.sonnet });
    await r.b.chat.whenIdle();
    expect(r.b.approvals.list()).toEqual([]);
    expect(JSON.stringify(r.ai.calls[1]!.request.body)).toContain('Daily brief: every 2 hours');
  });
});

describe('questions to the person', () => {
  const ask = (
    approvals: ApprovalService,
    over: Partial<Parameters<ApprovalService['request']>[0]> = {},
  ) =>
    approvals.request({
      summary: 'Post: hello',
      tool: 'post',
      args: { text: 'hello' },
      source: { kind: 'chat', chatId: 'chat1' },
      timeoutMs: 1000,
      ...over,
    });

  afterEach(() => vi.useRealTimers());

  it('waits for the answer, then reports the question as gone', async () => {
    const events = new Events();
    const lists: number[] = [];
    events.addSink({
      send: (channel, payload) => {
        if (channel === 'approvals:changed') lists.push((payload as unknown[]).length);
      },
    });
    const approvals = new ApprovalService(events);
    const answer = ask(approvals);
    const [pending] = approvals.list();
    expect(pending).toMatchObject({ summary: 'Post: hello', details: 'text: hello' });
    approvals.decide(pending!.id, true);
    expect(await answer).toBe(true);
    expect(approvals.list()).toEqual([]);
    expect(lists).toEqual([1, 0]);
    // An answer to a question that is gone is ignored.
    approvals.decide(pending!.id, false);
    expect(lists).toEqual([1, 0]);
  });

  it('counts no answer in time as a no', async () => {
    vi.useFakeTimers();
    const approvals = new ApprovalService(new Events());
    const answer = ask(approvals, { timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(approvals.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await answer).toBe(false);
    expect(approvals.list()).toEqual([]);
  });

  it('counts a stopped run as a no, and a run already stopped is never asked', async () => {
    const approvals = new ApprovalService(new Events());
    const controller = new AbortController();
    const answer = ask(approvals, { signal: controller.signal });
    expect(approvals.list()).toHaveLength(1);
    controller.abort();
    expect(await answer).toBe(false);
    expect(approvals.list()).toEqual([]);
    const late = ask(approvals, { signal: controller.signal, timeoutMs: 60_000 });
    expect(approvals.list()).toEqual([]);
    expect(await late).toBe(false);
  });

  it('counts every open question as a no when the app is closing', async () => {
    const approvals = new ApprovalService(new Events());
    const answers = [ask(approvals, { timeoutMs: 60_000 }), ask(approvals, { timeoutMs: 60_000 })];
    expect(approvals.list()).toHaveLength(2);
    approvals.denyAll();
    expect(approvals.list()).toEqual([]);
    expect(await Promise.all(answers)).toEqual([false, false]);
  });

  it('keeps the details short, and tells the screen of a new question without letting a failing notice stop it', async () => {
    const approvals = new ApprovalService(new Events(), {
      onRequest: () => {
        throw new Error('no notifications here');
      },
    });
    const answer = ask(approvals, { args: { n: 3, list: [1, 2], body: 'x'.repeat(5000) } });
    const [pending] = approvals.list();
    expect(pending!.details.length).toBeLessThanOrEqual(601);
    expect(pending!.details).toContain('n: 3\nlist: [1,2]');
    approvals.decide(pending!.id, true);
    expect(await answer).toBe(true);
  });

  it('asks on behalf of a chat, and a chat’s question disappears when its reply is stopped', async () => {
    const approvals = new ApprovalService(new Events());
    const approve = approverForChat(approvals);
    const controller = new AbortController();
    const answer = approve({
      summary: 'Do it',
      tool: { name: 'post' },
      args: {},
      signal: controller.signal,
      chatId: 'chatX',
    });
    expect(approvals.list()[0]).toMatchObject({ source: { kind: 'chat', chatId: 'chatX' } });
    controller.abort();
    expect(await answer).toBe(false);
  });
});

describe('schedules in words', () => {
  it('says when a task runs, plainly', () => {
    expect(describeSchedule({ kind: 'manual' })).toBe('only when you run it');
    expect(describeSchedule({ kind: 'every', minutes: 60 })).toBe('every hour');
    expect(describeSchedule({ kind: 'every', minutes: 180 })).toBe('every 3 hours');
    expect(describeSchedule({ kind: 'every', minutes: 45 })).toBe('every 45 minutes');
    expect(describeSchedule({ kind: 'daily', time: '08:30', days: [] })).toBe('every day at 08:30');
    expect(describeSchedule({ kind: 'daily', time: '08:30', days: [1, 3] })).toBe(
      'Monday, Wednesday at 08:30',
    );
    expect(describeSchedule({ kind: 'once', at: at(9, 30, 12).getTime() })).toContain('2026-10-12');
  });

  it('reads the schedule a model describes, and refuses what is unclear with what to fix', () => {
    const now = at(8);
    expect(scheduleFromArgs({}, now)).toEqual({ kind: 'manual' });
    expect(scheduleFromArgs({ when: 'every', every_minutes: 15 }, now)).toEqual({
      kind: 'every',
      minutes: 15,
    });
    expect(
      scheduleFromArgs({ when: 'daily', time: '07:05', days: ['sunday', 6, 'nonsense', 6] }, now),
    ).toEqual({ kind: 'daily', time: '07:05', days: [0, 6] });
    expect(scheduleFromArgs({ when: 'once', at: '2026-10-12T09:30' }, now)).toEqual({
      kind: 'once',
      at: new Date('2026-10-12T09:30').getTime(),
    });
    for (const bad of [
      { when: 'once', at: 'tomorrow-ish' },
      { when: 'every', every_minutes: 2 },
      { when: 'every', every_minutes: 'often' },
      { when: 'daily', time: '8am' },
      { when: 'weekly' },
    ]) {
      expect(() => scheduleFromArgs(bad, now), JSON.stringify(bad)).toThrow();
    }
  });

  it('builds the prompt without what is empty', () => {
    const text = buildTaskPrompt({ title: 'T', now: at(8) });
    expect(text).not.toContain("user's name");
    expect(text).not.toContain('standing instructions');
  });
});
