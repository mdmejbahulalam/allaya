import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDetail, TaskSummary } from '@allaya/validation';
import { TasksScreen } from '../../../apps/desktop/renderer/src/features/tasks/tasks-screen';
import { Sidebar } from '@renderer/components/shell/sidebar';
import { useBackendSync } from '@renderer/app/use-backend-sync';
import { useTasksStore, matchesTab, sortTasks } from '@renderer/stores/tasks';
import { useToastStore } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { renderUi } from '../../helpers/render';

const NOW = Date.UTC(2026, 8, 20, 10, 0);

const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'task_1',
  title: 'Move the report',
  state: 'COMPLETED',
  phase: 'COMPLETED',
  source: 'chat',
  language: 'en',
  planFirst: false,
  riskLevel: 'MEDIUM',
  filesChanged: 1,
  actionCount: 2,
  stepCount: 2,
  stepsDone: 2,
  running: false,
  queued: false,
  createdAt: NOW,
  startedAt: NOW,
  completedAt: NOW + 4000,
  updatedAt: NOW + 4000,
  ...over,
});

const detailOf = (task: TaskSummary, over: Partial<TaskDetail> = {}): TaskDetail => ({
  task,
  request: 'First find the report, then move it to Documents.',
  plan: { summary: 'Find the report and move it', successCriteria: 'It is in Documents' },
  steps: [
    {
      id: 'step_1',
      position: 0,
      planStepId: 's1',
      title: 'Find the report',
      optional: false,
      dependsOn: [],
      state: 'done',
      attempts: 1,
      summary: 'Found report.pdf in Downloads.',
      evidence: '• list_folder("Downloads")',
      unverified: false,
      startedAt: NOW,
      completedAt: NOW + 1000,
    },
    {
      id: 'step_2',
      position: 1,
      planStepId: 's2',
      title: 'Move it to Documents',
      optional: false,
      dependsOn: ['s1'],
      state: task.state === 'COMPLETED' ? 'done' : 'pending',
      attempts: 2,
      summary: 'Moved it.',
      evidence: '? move_file — could not be confirmed',
      unverified: true,
      toolHint: 'move_file',
    },
  ],
  events: [
    { id: 'e1', seq: 1, type: 'TASK_CREATED', createdAt: NOW },
    {
      id: 'e2',
      seq: 2,
      type: 'STATE_CHANGED',
      payload: { from: 'CREATED', to: 'ANALYZING' },
      createdAt: NOW,
    },
    {
      id: 'e3',
      seq: 3,
      type: 'TOOL_COMPLETED',
      payload: { tool: 'move_file', summary: 'Move report.pdf to Documents' },
      createdAt: NOW + 2000,
    },
  ],
  usage: { toolCalls: 2, modelTurns: 5, inputTokens: 100, outputTokens: 40, elapsedMs: 4000 },
  ...over,
});

let invoke: ReturnType<typeof vi.fn>;
let listeners: Map<string, Array<(payload: unknown) => void>>;

function bridge(
  details: Record<string, TaskDetail> = {},
  handlers: Record<string, (p: never) => unknown> = {},
) {
  listeners = new Map();
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const custom = handlers[channel];
    if (custom) {
      const value = await custom(payload as never);
      if (value && typeof value === 'object' && '__error' in value) {
        return { ok: false, error: value.__error };
      }
      return { ok: true, data: value };
    }
    if (channel === 'tasks:get') {
      const id = (payload as { id: string }).id;
      const found = details[id];
      return found
        ? { ok: true, data: found }
        : { ok: false, error: { code: 'NOT_FOUND', message: 'x', retryable: false } };
    }
    if (channel === 'tasks:create')
      return { ok: true, data: summary({ id: 'task_new', state: 'CREATED', title: 'New one' }) };
    if (channel === 'tasks:clearFinished') return { ok: true, data: { removed: 2 } };
    if (channel === 'tasks:list') return { ok: true, data: [] };
    if (channel.startsWith('tasks:')) return { ok: true, data: { ok: true } };
    return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: channel, retryable: false } };
  });
  (window as unknown as { allaya: unknown }).allaya = {
    invoke,
    subscribe: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () => undefined;
    },
  };
}

const seed = (tasks: TaskSummary[], selectedId: string | null = null) =>
  useTasksStore.setState({
    byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
    loaded: true,
    selectedId,
  });
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel);

beforeEach(() => {
  bridge();
  seed([]);
  useUiStore.setState({ route: 'tasks' });
});

describe('Tasks screen — the list', () => {
  it('shows an empty state and the composer when there are no tasks', async () => {
    renderUi(<TasksScreen />);
    expect(await screen.findByText('No tasks yet.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New task' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('lists tasks newest first, with state and progress, and filters by tab', async () => {
    seed([
      summary({ id: 'a', title: 'Old finished', createdAt: NOW - 3000 }),
      summary({
        id: 'b',
        title: 'Waiting for you',
        state: 'WAITING_FOR_USER',
        phase: 'WAITING_FOR_PERMISSION',
        pending: { kind: 'plan_approval' },
        stepsDone: 0,
        createdAt: NOW - 1000,
      }),
      summary({ id: 'c', title: 'Broke', state: 'FAILED', phase: 'FAILED', createdAt: NOW - 2000 }),
      summary({
        id: 'd',
        title: 'Working now',
        state: 'EXECUTING',
        phase: 'EXECUTING',
        running: true,
        stepsDone: 1,
        createdAt: NOW,
      }),
    ]);
    renderUi(<TasksScreen />);
    const list = await screen.findByRole('list', { name: 'Tasks' });
    const order = ['Working now', 'Waiting for you', 'Broke', 'Old finished'].map((title) =>
      list.textContent.indexOf(title),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(within(list).getByText('1 of 2 steps')).toBeInTheDocument();

    const tabs = screen.getByRole('tablist', { name: 'Filter tasks' });
    expect(within(tabs).getByRole('tab', { name: /All/ })).toHaveTextContent('4');
    await userEvent.click(within(tabs).getByRole('tab', { name: /Needs you/ }));
    expect(within(screen.getByRole('list', { name: 'Tasks' })).getAllByRole('button')).toHaveLength(
      1,
    );
    await userEvent.click(within(tabs).getByRole('tab', { name: /Failed/ }));
    expect(screen.getByText('Broke')).toBeInTheDocument();
    expect(screen.queryByText('Old finished')).not.toBeInTheDocument();
    await userEvent.click(within(tabs).getByRole('tab', { name: /Paused/ }));
    expect(screen.getByText('No tasks in this view.')).toBeInTheDocument();
  });

  it('clears finished tasks after asking the backend, and says how many', async () => {
    seed([summary()]);
    renderUi(<TasksScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Clear finished' }));
    expect(calls('tasks:clearFinished')).toHaveLength(1);
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain('Removed 2 tasks'),
    );
  });

  it('offers no "clear finished" while nothing has finished', async () => {
    seed([summary({ state: 'EXECUTING', phase: 'EXECUTING', running: true })]);
    renderUi(<TasksScreen />);
    await screen.findByRole('list', { name: 'Tasks' });
    expect(screen.queryByRole('button', { name: 'Clear finished' })).not.toBeInTheDocument();
  });
});

describe('Tasks screen — starting a task', () => {
  it('starts on Enter, keeps Shift+Enter as a newline, and opens the new task', async () => {
    renderUi(<TasksScreen />);
    const box = await screen.findByRole('textbox', { name: 'New task' });
    const start = screen.getByRole('button', { name: 'Start task' });
    expect(start).toBeDisabled();
    await userEvent.type(box, 'Tidy the desktop{Shift>}{Enter}{/Shift}then empty the trash');
    expect((box as HTMLTextAreaElement).value).toBe('Tidy the desktop\nthen empty the trash');
    expect(calls('tasks:create')).toHaveLength(0);
    await userEvent.type(box, '{Enter}');
    await waitFor(() => expect(calls('tasks:create')).toHaveLength(1));
    expect(calls('tasks:create')[0]![1]).toEqual({
      request: 'Tidy the desktop\nthen empty the trash',
      planFirst: false,
    });
    await waitFor(() => expect(useTasksStore.getState().selectedId).toBe('task_new'));
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('can ask to see the plan first', async () => {
    renderUi(<TasksScreen />);
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'New task' }),
      'Rename my files',
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Show me the plan before starting' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(calls('tasks:create')).toHaveLength(1));
    expect(calls('tasks:create')[0]![1]).toEqual({ request: 'Rename my files', planFirst: true });
  });

  it('never sends while an input method is composing (Bengali typing)', async () => {
    renderUi(<TasksScreen />);
    const box = await screen.findByRole('textbox', { name: 'New task' });
    await userEvent.type(box, 'ফাইল');
    box.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    expect(calls('tasks:create')).toHaveLength(0);
  });

  it('explains a refusal in the user’s language and keeps what was typed', async () => {
    bridge(
      {},
      {
        'tasks:create': () => ({
          __error: { code: 'INVALID_IPC_PAYLOAD', message: 'x', retryable: false },
        }),
      },
    );
    renderUi(<TasksScreen />);
    const box = await screen.findByRole('textbox', { name: 'New task' });
    await userEvent.type(box, 'Do it{Enter}');
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        "That request wasn't valid.",
      ),
    );
    expect((box as HTMLTextAreaElement).value).toBe('Do it');
  });
});

describe('Tasks screen — one task', () => {
  it('shows the result, the steps with what was reported and what was checked, and flags what could not be confirmed', async () => {
    const task = summary({ resultSummary: 'I moved report.pdf to Documents.', outcome: 'partial' });
    bridge({ task_1: detailOf(task) });
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    expect(within(pane).getByRole('heading', { name: 'Move the report' })).toBeInTheDocument();
    expect(within(pane).getByText('Partly done')).toBeInTheDocument();
    expect(within(pane).getByText('I moved report.pdf to Documents.')).toBeInTheDocument();
    expect(within(pane).getByText('Could not be confirmed')).toBeInTheDocument();
    expect(within(pane).getByText(/^5 AI calls, 2 actions, /)).toBeInTheDocument();
    // Step details are one click away and keep the model's words apart from the checks.
    const buttons = within(pane).getAllByRole('button', { name: 'Details' });
    await userEvent.click(buttons[1]!);
    expect(within(pane).getByText(/What Allaya reported: Moved it\./)).toBeInTheDocument();
    expect(within(pane).getByText(/What was checked:/)).toHaveTextContent('could not be confirmed');
    expect(within(pane).getByText(/2 attempts/)).toBeInTheDocument();
    // The activity log leaves out the noise.
    await userEvent.click(within(pane).getByText('Activity'));
    expect(within(pane).getByText('Task created')).toBeInTheDocument();
    expect(within(pane).getByText('Action done')).toBeInTheDocument();
    expect(within(pane).getByText('Move report.pdf to Documents')).toBeInTheDocument();
    expect(within(pane).queryByText('State changed')).not.toBeInTheDocument();
  });

  it('reviews a plan before anything is done, and sends the person’s decision', async () => {
    const task = summary({
      state: 'WAITING_FOR_USER',
      phase: 'WAITING_FOR_PERMISSION',
      pending: { kind: 'plan_approval' },
      stepsDone: 0,
      riskLevel: 'HIGH',
    });
    bridge({
      task_1: detailOf(task, {
        assessment: {
          risk: 'HIGH',
          tools: ['delete_file'],
          subjects: ['file_access', 'delete_files'],
          readOnly: false,
          needsApproval: true,
          reasons: ['risky_tool', 'sensitive_subject'],
        },
      }),
    });
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    expect(await within(pane).findByText('Review the plan')).toBeInTheDocument();
    expect(within(pane).getByText(/does not approve each action/)).toBeInTheDocument();
    expect(within(pane).getByText('Highest risk: High risk')).toBeInTheDocument();
    expect(within(pane).getByText('Uses: delete_file')).toBeInTheDocument();
    expect(within(pane).getByText('It includes risky actions')).toBeInTheDocument();
    expect(within(pane).getByText(/It touches something sensitive/)).toBeInTheDocument();
    expect(within(pane).getByText('Done when: It is in Documents')).toBeInTheDocument();
    await userEvent.click(within(pane).getByRole('button', { name: 'Approve plan' }));
    await waitFor(() =>
      expect(calls('tasks:approve')).toEqual([['tasks:approve', { id: 'task_1' }]]),
    );
    await userEvent.click(within(pane).getByRole('button', { name: "Don't do it" }));
    await waitFor(() =>
      expect(calls('tasks:reject')).toEqual([['tasks:reject', { id: 'task_1' }]]),
    );
  });

  it('asks the question the task has and sends the trimmed answer', async () => {
    const task = summary({
      state: 'WAITING_FOR_USER',
      phase: 'WAITING_FOR_PERMISSION',
      pending: { kind: 'question', question: 'Which report do you mean?' },
    });
    bridge({ task_1: detailOf(task) });
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    expect(await within(pane).findByText('Which report do you mean?')).toBeInTheDocument();
    const send = within(pane).getByRole('button', { name: 'Answer' });
    expect(send).toBeDisabled();
    const box = within(pane).getByRole('textbox', { name: 'Your answer' });
    await userEvent.type(box, '  the 2025 one  ');
    await userEvent.click(send);
    await waitFor(() =>
      expect(calls('tasks:answer')).toEqual([
        ['tasks:answer', { id: 'task_1', text: 'the 2025 one' }],
      ]),
    );
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it('tells the person what they declined and lets them carry on or stop', async () => {
    const task = summary({
      state: 'WAITING_FOR_USER',
      phase: 'WAITING_FOR_PERMISSION',
      pending: { kind: 'declined', tool: 'delete_file', summary: 'Move “old.txt” to the trash' },
    });
    bridge({ task_1: detailOf(task) });
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    expect(await within(pane).findByText('You declined an action')).toBeInTheDocument();
    expect(
      within(pane).getByText(/“Move “old.txt” to the trash” was not done/),
    ).toBeInTheDocument();
    await userEvent.click(within(pane).getByRole('button', { name: 'Carry on' }));
    await waitFor(() => expect(calls('tasks:resume')).toHaveLength(1));
    await userEvent.click(within(pane).getByRole('button', { name: 'Stop the task' }));
    await waitFor(() => expect(calls('tasks:cancel')).toHaveLength(1));
  });

  it('says when a question went unanswered rather than declined', async () => {
    const task = summary({
      state: 'WAITING_FOR_USER',
      phase: 'WAITING_FOR_PERMISSION',
      pending: { kind: 'declined', tool: 'write_file', summary: 'Save note.txt', unanswered: true },
    });
    bridge({ task_1: detailOf(task) });
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    expect(await within(pane).findByText('No answer in time')).toBeInTheDocument();
    expect(within(pane).queryByText('You declined an action')).not.toBeInTheDocument();
    expect(
      within(pane).getByText(/“Save note.txt” was not done because there was no answer in time/),
    ).toBeInTheDocument();
  });

  it('says why a task is paused, and never repeats anything until resumed', async () => {
    const task = summary({
      state: 'PAUSED',
      phase: 'PAUSED',
      pauseReason: 'interrupted',
      stepsDone: 1,
    });
    bridge({ task_1: detailOf(task) });
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    expect(
      await within(pane).findByText(/Allaya was closed while this was running/),
    ).toBeInTheDocument();
    expect(within(pane).getByText(/Nothing is repeated unless you resume it/)).toBeInTheDocument();
    await userEvent.click(within(pane).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(calls('tasks:resume')).toHaveLength(1));
  });

  it('offers pause and stop while a task runs, and shows a queued task as waiting its turn', async () => {
    const running = summary({
      state: 'EXECUTING',
      phase: 'EXECUTING',
      running: true,
      stepsDone: 1,
    });
    bridge({ task_1: detailOf(running) });
    seed([running], 'task_1');
    const view = renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    await userEvent.click(await within(pane).findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calls('tasks:pause')).toHaveLength(1));
    await userEvent.click(within(pane).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(calls('tasks:cancel')).toHaveLength(1));
    view.unmount();

    const queued = summary({
      id: 'q',
      title: 'Second in line',
      state: 'CREATED',
      phase: 'IDLE',
      queued: true,
      stepCount: 0,
      stepsDone: 0,
    });
    bridge({ q: detailOf(queued, { steps: [] }) });
    seed([queued], 'q');
    renderUi(<TasksScreen />);
    const pane2 = await screen.findByTestId('task-detail');
    expect(await within(pane2).findAllByText('Waiting for its turn')).not.toHaveLength(0);
  });

  it('runs a finished task again, and removes it on request', async () => {
    const task = summary();
    bridge({ task_1: detailOf(task) });
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    await userEvent.click(await within(pane).findByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(calls('tasks:create')).toHaveLength(1));
    expect(calls('tasks:create')[0]![1]).toEqual({
      request: 'First find the report, then move it to Documents.',
    });
    await waitFor(() => expect(useTasksStore.getState().selectedId).toBe('task_new'));
  });

  it('removes a finished task', async () => {
    const task = summary();
    bridge({ task_1: detailOf(task) });
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    await userEvent.click(await within(pane).findByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls('tasks:remove')).toEqual([['tasks:remove', { id: 'task_1' }]]),
    );
    await waitFor(() => expect(useTasksStore.getState().selectedId).toBeNull());
  });

  it('shows why a failed task stopped, and reports a refused action plainly', async () => {
    const task = summary({
      state: 'FAILED',
      phase: 'FAILED',
      resultSummary: 'Finished 1 of 2 steps. Move it to Documents: no action was taken.',
      error: { code: 'TOOL_EXECUTION_FAILED', message: 'x' },
    });
    bridge(
      { task_1: detailOf(task) },
      { 'tasks:remove': () => ({ __error: { code: 'CONFLICT', message: 'x', retryable: false } }) },
    );
    seed([task], 'task_1');
    renderUi(<TasksScreen />);
    const pane = await screen.findByTestId('task-detail');
    expect(
      await within(pane).findByRole('heading', { name: 'Why it stopped' }),
    ).toBeInTheDocument();
    expect(within(pane).getByText(/Finished 1 of 2 steps/)).toBeInTheDocument();
    await userEvent.click(within(pane).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        "That can't be done right now.",
      ),
    );
  });

  it('says so when the task no longer exists', async () => {
    seed([], 'gone');
    renderUi(<TasksScreen />);
    // No tasks at all: the empty state; with one, an unknown selection shows the message.
    seed([summary()], 'gone');
    renderUi(<TasksScreen />);
    expect(await screen.findByText('That no longer exists.')).toBeInTheDocument();
  });

  it('speaks Bengali when the interface is Bengali', async () => {
    const task = summary({
      state: 'WAITING_FOR_USER',
      phase: 'WAITING_FOR_PERMISSION',
      pending: { kind: 'plan_approval' },
    });
    bridge({ task_1: detailOf(task) });
    seed([task], 'task_1');
    renderUi(<TasksScreen />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByText('পরিকল্পনাটি দেখে নিন')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'পরিকল্পনা অনুমোদন করুন' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'কাজ শুরু করুন' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /আপনার অপেক্ষায়/ })).toBeInTheDocument();
  });
});

describe('the tasks store', () => {
  it('ignores an update older than what it already knows', () => {
    seed([summary({ state: 'EXECUTING', updatedAt: 200 })]);
    const previous = useTasksStore.getState().apply(summary({ state: 'PLANNING', updatedAt: 100 }));
    expect(previous?.state).toBe('EXECUTING');
    expect(useTasksStore.getState().byId['task_1']!.state).toBe('EXECUTING');
  });

  it('returns what was known, so a change of state can be noticed', () => {
    seed([summary({ state: 'EXECUTING', updatedAt: 100 })]);
    const previous = useTasksStore
      .getState()
      .apply(summary({ state: 'COMPLETED', updatedAt: 200 }));
    expect(previous?.state).toBe('EXECUTING');
    expect(useTasksStore.getState().byId['task_1']!.state).toBe('COMPLETED');
    expect(useTasksStore.getState().apply(summary({ id: 'other' }))).toBeUndefined();
  });

  it('forgets removed tasks, including the open one', () => {
    seed([summary(), summary({ id: 'b' })], 'b');
    useTasksStore.getState().removeMany(['b']);
    expect(Object.keys(useTasksStore.getState().byId)).toEqual(['task_1']);
    expect(useTasksStore.getState().selectedId).toBeNull();
  });

  it('keeps the newer of what was pushed and what was loaded', async () => {
    seed([summary({ state: 'COMPLETED', updatedAt: 500 })]);
    bridge(
      {},
      {
        'tasks:list': () => [summary({ state: 'EXECUTING', updatedAt: 100 }), summary({ id: 'b' })],
      },
    );
    await useTasksStore.getState().load();
    expect(useTasksStore.getState().byId['task_1']!.state).toBe('COMPLETED');
    expect(useTasksStore.getState().byId['b']).toBeDefined();
  });

  it('sorts newest first and matches tabs', () => {
    const list = sortTasks({
      a: summary({ id: 'a', createdAt: 1 }),
      b: summary({ id: 'b', createdAt: 3 }),
      c: summary({ id: 'c', createdAt: 2 }),
    });
    expect(list.map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(matchesTab(summary({ state: 'CANCELLED' }), 'failed')).toBe(true);
    expect(matchesTab(summary({ state: 'PAUSED' }), 'paused')).toBe(true);
    expect(matchesTab(summary({ state: 'PAUSED' }), 'running')).toBe(false);
    expect(matchesTab(summary({ state: 'WAITING_FOR_USER' }), 'waiting')).toBe(true);
    expect(matchesTab(summary({ state: 'WAITING_FOR_USER' }), 'running')).toBe(false);
    expect(matchesTab(summary({ state: 'RETRY' }), 'running')).toBe(true);
  });
});

describe('what the rest of the app shows about tasks', () => {
  it('marks Tasks in the sidebar when something needs the person', () => {
    seed([
      summary({ id: 'a', state: 'WAITING_FOR_USER', pending: { kind: 'plan_approval' } }),
      summary({ id: 'b', state: 'WAITING_FOR_USER', pending: { kind: 'question', question: '?' } }),
      summary({ id: 'c' }),
    ]);
    renderUi(
      <Sidebar
        route="home"
        collapsed={false}
        pinned
        overlay={false}
        canToggle
        onNavigate={() => undefined}
        onNewTask={() => undefined}
        onToggleCollapsed={() => undefined}
        onTogglePinned={() => undefined}
      />,
    );
    const badge = screen.getByTestId('tasks-waiting');
    expect(badge).toHaveTextContent('2');
    expect(within(badge).getByText('2 tasks need you')).toBeInTheDocument();
  });

  it('shows no marker when nothing is waiting', () => {
    seed([summary()]);
    renderUi(
      <Sidebar
        route="home"
        collapsed={false}
        pinned
        overlay={false}
        canToggle
        onNavigate={() => undefined}
        onNewTask={() => undefined}
        onToggleCollapsed={() => undefined}
        onTogglePinned={() => undefined}
      />,
    );
    expect(screen.queryByTestId('tasks-waiting')).not.toBeInTheDocument();
  });

  it('notifies the person once when a task they cannot see finishes, fails, or needs them', async () => {
    function Probe() {
      useBackendSync();
      return null;
    }
    renderUi(<Probe />);
    const emit = (task: TaskSummary) =>
      act(() => listeners.get('tasks:changed')!.forEach((listener) => listener(task)));
    const messages = () => useToastStore.getState().toasts.map((t) => t.message);

    emit(summary({ id: 'x', title: 'Tidy up', state: 'EXECUTING', updatedAt: 1 }));
    expect(messages()).toEqual([]); // first sight of a task is not news
    emit(summary({ id: 'x', title: 'Tidy up', state: 'EXECUTING', updatedAt: 2 }));
    expect(messages()).toEqual([]); // no change of state
    emit(summary({ id: 'x', title: 'Tidy up', state: 'COMPLETED', updatedAt: 3 }));
    expect(messages()).toEqual(['“Tidy up” is done']);

    emit(summary({ id: 'y', title: 'Sort files', state: 'EXECUTING', updatedAt: 1 }));
    emit(
      summary({
        id: 'y',
        title: 'Sort files',
        state: 'COMPLETED',
        outcome: 'partial',
        updatedAt: 2,
      }),
    );
    emit(summary({ id: 'z', title: 'Copy files', state: 'EXECUTING', updatedAt: 1 }));
    emit(summary({ id: 'z', title: 'Copy files', state: 'FAILED', updatedAt: 2 }));
    emit(summary({ id: 'w', title: 'Rename files', state: 'EXECUTING', updatedAt: 1 }));
    emit(
      summary({
        id: 'w',
        title: 'Rename files',
        state: 'WAITING_FOR_USER',
        pending: { kind: 'plan_approval' },
        updatedAt: 2,
      }),
    );
    expect(messages()).toEqual([
      '“Tidy up” is done',
      '“Sort files” is partly done',
      '“Copy files” did not finish',
      '“Rename files” needs you',
    ]);
    const kinds = useToastStore.getState().toasts.map((t) => t.kind);
    expect(kinds).toEqual(['success', 'warning', 'error', 'warning']);

    // The notification takes the person to the task.
    const last = useToastStore.getState().toasts.at(-1)!;
    expect(last.actionLabel).toBe('Open');
    act(() => last.onAction?.());
    expect(useUiStore.getState().route).toBe('tasks');
    expect(useTasksStore.getState().selectedId).toBe('w');
  });

  it('forgets tasks the backend removed', () => {
    function Probe() {
      useBackendSync();
      return null;
    }
    renderUi(<Probe />);
    seed([summary()]);
    act(() => listeners.get('tasks:removed')!.forEach((listener) => listener({ ids: ['task_1'] })));
    expect(useTasksStore.getState().byId).toEqual({});
  });
});
