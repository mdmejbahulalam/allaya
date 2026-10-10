import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalView, RunView, TaskView } from '@lite/shared/ipc';
import { ApprovalsPanel } from '@lite/renderer/src/components/approvals-panel';
import { Sidebar } from '@lite/renderer/src/components/sidebar';
import { TasksScreen } from '@lite/renderer/src/components/tasks-screen';
import { GeneralPanel } from '@lite/renderer/src/settings/general-panel';
import { translate, type Lang, type TextKey, type Translator } from '@lite/renderer/src/i18n';
import { en } from '@lite/renderer/src/i18n/en';
import { describeSchedule } from '@lite/renderer/src/lib/schedule-text';
import {
  draftFromTask,
  draftToInput,
  emptyDraft,
  type Draft,
} from '@lite/renderer/src/lib/task-draft';
import { toLocalInput } from '@lite/renderer/src/lib/time';
import { useAppStore } from '@lite/renderer/src/stores/app';
import { useApprovalsStore } from '@lite/renderer/src/stores/approvals';
import { useConnectionsStore } from '@lite/renderer/src/stores/connections';
import { useTasksStore } from '@lite/renderer/src/stores/tasks';
import { bridge, fail, model, renderLite, resetStores } from './helpers';

const run = (over: Partial<RunView> = {}): RunView => ({
  id: 'run1',
  taskId: 't1',
  taskTitle: 'Morning news',
  trigger: 'manual',
  status: 'done',
  startedAt: Date.UTC(2026, 9, 12, 6, 0),
  finishedAt: Date.UTC(2026, 9, 12, 6, 1),
  model: 'Claude Haiku',
  result: 'The **headline** is calm.',
  steps: [],
  ...over,
});

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1',
  title: 'Morning news',
  instructions: 'Read example.com and tell me the headline.',
  model: { connectionId: 'c1', modelId: 'claude-haiku' },
  schedule: { kind: 'daily', time: '08:30', days: [1, 5] },
  groups: ['browser'],
  enabled: true,
  nextRunAt: Date.UTC(2026, 9, 19, 2, 30),
  running: false,
  createdBy: 'person',
  createdAt: 1,
  lastRun: run(),
  ...over,
});

const haiku = model({
  modelId: 'claude-haiku',
  displayName: 'Claude Haiku',
  tier: 'fast',
});
const sonnet = model();

const translator = (lang: Lang): Translator => ({
  lang,
  t: (key, params) => translate(lang, key, params),
  has: (key): key is TextKey => key in en,
});

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([c]) => c === channel);

beforeEach(() => {
  resetStores();
  useTasksStore.setState({ tasks: [], loaded: true, view: { kind: 'list' }, runs: [] });
  useApprovalsStore.setState({ pending: [] });
  useConnectionsStore.setState({ models: [haiku, sonnet] });
  bridge();
});

describe('the form behind a task', () => {
  const now = new Date(2026, 9, 10, 12, 0);
  const filled = (over: Partial<Draft> = {}): Draft => ({
    ...emptyDraft(),
    title: ' Morning news ',
    instructions: ' Read it. ',
    ...over,
  });

  it('asks for a name and instructions, and says nothing else is wrong about a task run by hand', () => {
    expect(draftToInput(emptyDraft(), now).errors).toEqual({
      title: 'tasks.err.title',
      instructions: 'tasks.err.instructions',
    });
    expect(draftToInput(filled(), now)).toEqual({
      input: {
        title: 'Morning news',
        instructions: 'Read it.',
        model: null,
        schedule: { kind: 'manual' },
        groups: ['browser'],
      },
    });
  });

  it('turns hours and minutes into minutes, and refuses what the engine would', () => {
    const every = (everyN: string, unit: Draft['unit']) =>
      draftToInput(filled({ kind: 'every', everyN, unit }), now);
    expect(every('1', 'hours').input?.schedule).toEqual({ kind: 'every', minutes: 60 });
    expect(every('2', 'hours').input?.schedule).toEqual({ kind: 'every', minutes: 120 });
    expect(every('5', 'minutes').input?.schedule).toEqual({ kind: 'every', minutes: 5 });
    for (const [n, unit] of [
      ['4', 'minutes'],
      ['', 'hours'],
      ['abc', 'minutes'],
      ['1.5', 'minutes'],
      ['169', 'hours'],
      ['0', 'hours'],
    ] as const) {
      expect(every(n, unit).errors, `${n} ${unit}`).toEqual({ every: 'tasks.err.every' });
    }
    expect(every('168', 'hours').input?.schedule).toEqual({ kind: 'every', minutes: 10080 });
  });

  it('takes a time of day and the days, in order; a bad time is refused', () => {
    expect(
      draftToInput(filled({ kind: 'daily', time: '08:30', days: [5, 1] }), now).input?.schedule,
    ).toEqual({ kind: 'daily', time: '08:30', days: [1, 5] });
    expect(draftToInput(filled({ kind: 'daily', time: '' }), now).errors).toEqual({
      time: 'tasks.err.time',
    });
  });

  it('takes a one-off time in the computer’s clock, and only a time still to come', () => {
    const at = new Date(2026, 9, 12, 9, 30);
    expect(
      draftToInput(filled({ kind: 'once', at: toLocalInput(at.getTime()) }), now).input?.schedule,
    ).toEqual({ kind: 'once', at: at.getTime() });
    expect(draftToInput(filled({ kind: 'once', at: '2026-10-10T11:59' }), now).errors).toEqual({
      at: 'tasks.err.in_the_past',
    });
    expect(draftToInput(filled({ kind: 'once', at: '' }), now).errors).toEqual({
      at: 'tasks.err.once',
    });
  });

  it('keeps the tool groups it has no switch for', () => {
    expect(draftToInput(filled({ browser: false }), now, ['gmail']).input?.groups).toEqual([
      'gmail',
    ]);
    expect(draftToInput(filled({ browser: true }), now, ['gmail']).input?.groups).toEqual([
      'browser',
      'gmail',
    ]);
  });

  it('shows a saved task back in the form as it was entered', () => {
    expect(
      draftFromTask(task({ schedule: { kind: 'every', minutes: 120 }, groups: [] })),
    ).toMatchObject({ kind: 'every', everyN: '2', unit: 'hours', browser: false });
    expect(draftFromTask(task({ schedule: { kind: 'every', minutes: 45 } }))).toMatchObject({
      everyN: '45',
      unit: 'minutes',
    });
    const at = new Date(2026, 9, 12, 9, 30).getTime();
    expect(draftFromTask(task({ schedule: { kind: 'once', at } })).at).toBe('2026-10-12T09:30');
    expect(draftFromTask(task())).toMatchObject({
      kind: 'daily',
      time: '08:30',
      days: [1, 5],
      model: { connectionId: 'c1', modelId: 'claude-haiku' },
    });
  });
});

describe('a schedule in words', () => {
  it('reads plainly in English', () => {
    const t = translator('en');
    expect(describeSchedule(t, { kind: 'manual' })).toBe('Only when you run it');
    expect(describeSchedule(t, { kind: 'every', minutes: 60 })).toBe('Every hour');
    expect(describeSchedule(t, { kind: 'every', minutes: 180 })).toBe('Every 3 hours');
    expect(describeSchedule(t, { kind: 'every', minutes: 45 })).toBe('Every 45 minutes');
    expect(describeSchedule(t, { kind: 'daily', time: '08:30', days: [] })).toBe(
      'Every day at 08:30',
    );
    expect(describeSchedule(t, { kind: 'daily', time: '08:30', days: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      'Every day at 08:30',
    );
    expect(describeSchedule(t, { kind: 'daily', time: '08:30', days: [5, 1] })).toBe(
      'Mon, Fri at 08:30',
    );
  });

  it('reads in Bengali, with Bengali day names', () => {
    const text = describeSchedule(translator('bn'), {
      kind: 'daily',
      time: '08:30',
      days: [1, 5],
    });
    expect(text).toMatch(/[ঀ-৿]/);
    expect(text).toContain('08:30');
    expect(describeSchedule(translator('bn'), { kind: 'every', minutes: 60 })).toBe(
      'প্রতি ঘণ্টায়',
    );
  });
});

describe('the tasks list', () => {
  it('invites the person to make a first task, and points to a service if none is connected', async () => {
    renderLite(<TasksScreen />);
    expect(screen.getByText('No tasks yet')).toBeVisible();
    expect(screen.getByText(/Every morning at 8/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Connect a service' }));
    expect(useAppStore.getState()).toMatchObject({ route: 'settings', settingsTab: 'providers' });
  });

  it('shows each task with when it runs, its model, and how it last went', () => {
    useTasksStore.setState({
      tasks: [
        task(),
        task({
          id: 't2',
          title: 'Weekly report',
          model: null,
          schedule: { kind: 'manual' },
          nextRunAt: null,
          lastRun: null,
        }),
        task({
          id: 't3',
          title: 'Paused thing',
          enabled: false,
          schedule: { kind: 'every', minutes: 120 },
          model: { connectionId: 'zzz', modelId: 'gone-model' },
        }),
      ],
    });
    renderLite(<TasksScreen />);
    const [first, second, third] = screen.getAllByTestId('task');
    expect(within(first!).getByText(/Mon, Fri at 08:30 · Claude Haiku/)).toBeVisible();
    expect(within(first!).getByText(/Done/)).toBeVisible();
    expect(within(first!).getByText(/Next:/)).toBeVisible();
    expect(within(second!).getByText('Only when you run it · Default model')).toBeVisible();
    expect(within(second!).getByText('Not run yet')).toBeVisible();
    expect(within(second!).queryByText(/Next:/)).toBeNull();
    // A model that is gone is still named, not hidden.
    expect(within(third!).getByText(/Every 2 hours · gone-model/)).toBeVisible();
    expect(within(third!).getByText('Paused')).toBeVisible();
  });

  it('runs a task now, and says why when it cannot', async () => {
    useTasksStore.setState({ tasks: [task()] });
    const invoke = bridge({
      'tasks:run': () => {
        throw fail('LIMIT_EXCEEDED', 'busy', { reason: 'busy' });
      },
    });
    renderLite(<TasksScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(invoke).toHaveBeenCalledWith('tasks:run', { id: 't1' });
    expect(await screen.findByRole('alert')).toHaveTextContent('This task is already running.');
  });

  it('shows Stop while a task runs, and stops that run', async () => {
    useTasksStore.setState({
      tasks: [task({ running: true, lastRun: run({ id: 'run9', status: 'running', result: '' }) })],
    });
    const invoke = bridge();
    renderLite(<TasksScreen />);
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(invoke).toHaveBeenCalledWith('tasks:cancel', { runId: 'run9' });
  });

  it('cannot be run again, nor stopped, in the moment a run is starting', () => {
    useTasksStore.setState({ tasks: [task({ running: true })] });
    renderLite(<TasksScreen />);
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
});

describe('making a task', () => {
  const open = async () => {
    renderLite(<TasksScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'New task' }));
  };

  it('is told what is missing, and nothing is sent', async () => {
    const invoke = bridge();
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(screen.getByText('Give the task a name.')).toBeVisible();
    expect(screen.getByText('Say what the task should do.')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(calls(invoke, 'tasks:create')).toHaveLength(0);
  });

  it('sends the name, the instructions, the model the need points to and the schedule — then shows the task', async () => {
    const created = task({ id: 'new1', title: 'Rankings', lastRun: null, nextRunAt: null });
    const invoke = bridge({
      'tasks:create': () => created,
      'tasks:list': () => [created],
      'tasks:get': () => ({ task: created, runs: [] }),
    });
    await open();
    await userEvent.type(screen.getByLabelText('Name'), 'Rankings');
    await userEvent.type(screen.getByLabelText('What should Allaya do?'), 'Check the rankings');
    // The picker says "Default model" until a model is chosen; a need picks the one that fits.
    expect(screen.getByRole('button', { name: 'Model: Default model' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Fast and cheap' }));
    expect(screen.getByRole('button', { name: 'Model: Claude Haiku' })).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText('When'), 'every');
    await userEvent.clear(screen.getByLabelText('Every'));
    await userEvent.type(screen.getByLabelText('Every'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tasks:create', {
        title: 'Rankings',
        instructions: 'Check the rankings',
        model: { connectionId: 'c1', modelId: 'claude-haiku' },
        schedule: { kind: 'every', minutes: 120 },
        groups: ['browser'],
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Rankings' })).toBeVisible();
    expect(useTasksStore.getState().view).toEqual({ kind: 'detail', id: 'new1' });
  });

  it('can go back to the default model after choosing one', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Hard thinking' }));
    expect(screen.getByRole('button', { name: /^Model: Claude/ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Use the default model' }));
    expect(screen.getByRole('button', { name: 'Model: Default model' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use the default model' })).toBeNull();
  });

  it('says so when a need cannot be met because no model is connected', async () => {
    useConnectionsStore.setState({ models: [] });
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Fast and cheap' }));
    expect(screen.getByRole('status')).toHaveTextContent('There is no model to pick');
  });

  it('shows the fields of the chosen schedule only', async () => {
    await open();
    expect(screen.queryByLabelText('Date and time')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('When'), 'once');
    expect(screen.getByLabelText('Date and time')).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText('When'), 'daily');
    expect(screen.getByLabelText('Time')).toBeVisible();
    const monday = screen.getByRole('button', { name: 'Monday' });
    expect(monday).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(monday);
    expect(monday).toHaveAttribute('aria-pressed', 'true');
    await userEvent.selectOptions(screen.getByLabelText('When'), 'manual');
    expect(screen.queryByLabelText('Time')).toBeNull();
  });

  it('refuses a time that has passed before asking the engine', async () => {
    const invoke = bridge();
    await open();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.type(screen.getByLabelText('What should Allaya do?'), 'y');
    await userEvent.selectOptions(screen.getByLabelText('When'), 'once');
    fireEvent.change(screen.getByLabelText('Date and time'), {
      target: { value: '2001-01-01T09:00' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(screen.getByText('That time has already passed.')).toBeVisible();
    expect(calls(invoke, 'tasks:create')).toHaveLength(0);
  });

  it('shows the engine’s reason when it refuses, and stays on the form', async () => {
    bridge({
      'tasks:create': () => {
        throw fail('LIMIT_EXCEEDED', 'many', { reason: 'too_many' });
      },
    });
    await open();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.type(screen.getByLabelText('What should Allaya do?'), 'y');
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('There are too many tasks.');
    expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled();
  });

  it('cancel goes back to the list', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  });
});

describe('one task', () => {
  const show = (
    t: TaskView,
    runs: RunView[] = [],
    handlers: Record<string, () => unknown> = {},
  ) => {
    useTasksStore.setState({ tasks: [t], view: { kind: 'detail', id: t.id }, runs });
    const invoke = bridge({
      'tasks:get': () => ({ task: t, runs }),
      'tasks:list': () => [t],
      ...handlers,
    });
    renderLite(<TasksScreen />);
    return invoke;
  };

  it('shows what it does and the latest report, written in Markdown', async () => {
    show(task(), [run()]);
    expect(await screen.findByRole('heading', { name: 'Morning news' })).toBeVisible();
    expect(screen.getByText('Read example.com and tell me the headline.')).toBeVisible();
    expect(screen.getByText('Open and read web pages')).toBeVisible();
    const report = await screen.findByTestId('report');
    expect(within(report).getByText('headline').tagName).toBe('STRONG');
    expect(within(report).getByText(/Claude Haiku/)).toBeVisible();
    expect(within(report).getByText(/run by you/)).toBeVisible();
  });

  it('shows another run’s report when it is picked', async () => {
    show(task(), [
      run({ id: 'r2', startedAt: Date.UTC(2026, 9, 13, 6, 0), result: 'Second report' }),
      run({ id: 'r1', result: 'First report' }),
    ]);
    expect(await screen.findByText('Second report')).toBeVisible();
    const buttons = screen.getAllByRole('button', { pressed: false });
    await userEvent.click(buttons.find((b) => b.getAttribute('aria-pressed') === 'false')!);
    expect(screen.getByText('First report')).toBeVisible();
    expect(screen.queryByText('Second report')).toBeNull();
  });

  it('says plainly why a run did not finish, and what the steps were', async () => {
    show(task(), [
      run({
        status: 'error',
        result: '',
        error: { code: 'LIMIT_EXCEEDED', message: 'raw' },
        steps: [{ id: 's1', tool: 'open_url', summary: 'Open example.com', status: 'done' }],
      }),
    ]);
    const report = await screen.findByTestId('report');
    expect(within(report).getByText('Failed')).toBeVisible();
    expect(within(report).getByRole('alert')).toHaveTextContent(
      'The task used too many steps without reaching a result.',
    );
    expect(within(report).getByText('Open example.com')).toBeVisible();
  });

  it('says a run was cut off when the app closed', async () => {
    show(task(), [
      run({ status: 'cancelled', result: '', error: { code: 'CANCELLED', message: 'raw' } }),
    ]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Allaya was closed while this ran.');
  });

  it('pauses and resumes a task that has a schedule, but a manual task has no such switch', async () => {
    const invoke = show(task(), [run()], { 'tasks:update': () => task({ enabled: false }) });
    await userEvent.click(await screen.findByRole('switch', { name: 'Run on its schedule' }));
    expect(invoke).toHaveBeenCalledWith('tasks:update', { id: 't1', changes: { enabled: false } });
  });

  it('has no schedule switch on a task run by hand', async () => {
    show(task({ schedule: { kind: 'manual' }, nextRunAt: null }), [run()]);
    await screen.findByRole('heading', { name: 'Morning news' });
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('asks before deleting, and goes back to the list after', async () => {
    const invoke = show(task(), [run()]);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(invoke).not.toHaveBeenCalledWith('tasks:remove', expect.anything());
    expect(screen.getByText('Delete “Morning news” and its reports?')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText(/and its reports/)).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('tasks:remove', expect.anything());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(invoke).toHaveBeenCalledWith('tasks:remove', { id: 't1' });
    expect(useTasksStore.getState().view).toEqual({ kind: 'list' });
  });

  it('shows who made the task when Allaya did', async () => {
    show(task({ createdBy: 'allaya' }), [run()]);
    expect(await screen.findByText(/Set up by Allaya/)).toBeVisible();
  });

  it('edits a task: fills the form with it, saves the changes, keeps it on or off, and keeps other tool groups', async () => {
    const t = task({ groups: ['browser', 'gmail'], enabled: false });
    const invoke = show(t, [run()], { 'tasks:update': () => t });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Morning news');
    expect(screen.getByRole('button', { name: 'Model: Claude Haiku' })).toBeVisible();
    expect(screen.getByLabelText('Time')).toHaveValue('08:30');
    await userEvent.click(screen.getByRole('checkbox', { name: /Let it open and read web pages/ }));
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Evening news');
    await userEvent.click(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tasks:update', {
        id: 't1',
        changes: {
          title: 'Evening news',
          instructions: 'Read example.com and tell me the headline.',
          model: { connectionId: 'c1', modelId: 'claude-haiku' },
          schedule: { kind: 'daily', time: '08:30', days: [1, 5] },
          groups: ['gmail'],
          enabled: false,
        },
      }),
    );
  });
});

describe('what the engine reports while tasks run', () => {
  it('updates the card as a run progresses and ends, without asking again', () => {
    useTasksStore.setState({ tasks: [task({ lastRun: null })] });
    renderLite(<TasksScreen />);
    act(() => useTasksStore.getState().onRun(run({ id: 'r1', status: 'running', result: '' })));
    expect(useTasksStore.getState().tasks[0]).toMatchObject({ running: true });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
    act(() => useTasksStore.getState().onRun(run({ id: 'r1', status: 'done', result: 'ok' })));
    expect(useTasksStore.getState().tasks[0]).toMatchObject({ running: false });
    expect(screen.getByRole('button', { name: 'Run now' })).toBeVisible();
  });

  it('does not let an old run’s late news replace a newer one', () => {
    useTasksStore.setState({
      tasks: [task({ lastRun: run({ id: 'new', startedAt: 2000 }) })],
    });
    act(() => useTasksStore.getState().onRun(run({ id: 'old', startedAt: 1000, status: 'done' })));
    expect(useTasksStore.getState().tasks[0]!.lastRun!.id).toBe('new');
  });

  it('adds a new run to the open task’s reports, and replaces one it has', () => {
    useTasksStore.setState({
      tasks: [task()],
      view: { kind: 'detail', id: 't1' },
      runs: [run({ id: 'r1', result: 'first' })],
    });
    act(() => useTasksStore.getState().onRun(run({ id: 'r2', startedAt: 9e12, result: 'second' })));
    act(() =>
      useTasksStore.getState().onRun(run({ id: 'r2', startedAt: 9e12, result: 'second!' })),
    );
    expect(useTasksStore.getState().runs.map((r) => [r.id, r.result])).toEqual([
      ['r2', 'second!'],
      ['r1', 'first'],
    ]);
  });

  it('goes back to the list when the open task is deleted elsewhere', async () => {
    useTasksStore.setState({ tasks: [task()], view: { kind: 'detail', id: 't1' }, runs: [] });
    bridge({
      'tasks:list': () => [],
      'tasks:get': () => {
        throw fail('NOT_FOUND');
      },
    });
    await act(() => useTasksStore.getState().onChanged());
    expect(useTasksStore.getState().view).toEqual({ kind: 'list' });
  });
});

describe('questions from Allaya', () => {
  const approval = (over: Partial<ApprovalView> = {}): ApprovalView => ({
    id: 'ap1',
    summary: 'Create the task “Morning rankings” — Monday, Friday at 08:30',
    tool: 'create_task',
    details: 'title: Morning rankings',
    source: { kind: 'chat', chatId: 'chat1' },
    createdAt: 1,
    expiresAt: 2,
    ...over,
  });

  it('shows nothing when nothing is asked', () => {
    renderLite(<ApprovalsPanel />);
    expect(screen.queryByTestId('approval')).toBeNull();
  });

  it('shows what Allaya wants to do, where from, and the details on request', () => {
    useApprovalsStore.setState({
      pending: [
        approval(),
        approval({
          id: 'ap2',
          summary: 'Open an issue',
          source: { kind: 'task', taskId: 't1', taskTitle: 'Morning news' },
        }),
      ],
    });
    renderLite(<ApprovalsPanel />);
    const [first, second] = screen.getAllByTestId('approval');
    expect(within(first!).getByText(/Create the task “Morning rankings”/)).toBeVisible();
    expect(within(first!).getByText(/in a chat/)).toBeVisible();
    expect(within(first!).getByText('title: Morning rankings')).toBeInTheDocument();
    expect(within(second!).getByText(/task “Morning news”/)).toBeVisible();
  });

  it('sends the answer, and the question goes away at once', async () => {
    useApprovalsStore.setState({ pending: [approval(), approval({ id: 'ap2', summary: 'Two' })] });
    const invoke = bridge();
    renderLite(<ApprovalsPanel />);
    const [first] = screen.getAllByTestId('approval');
    await userEvent.click(within(first!).getByRole('button', { name: 'Allow' }));
    expect(invoke).toHaveBeenCalledWith('approvals:decide', { id: 'ap1', allow: true });
    expect(screen.getAllByTestId('approval')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Don’t allow' }));
    expect(invoke).toHaveBeenCalledWith('approvals:decide', { id: 'ap2', allow: false });
    expect(screen.queryByTestId('approval')).toBeNull();
  });

  it('puts the question back if the answer could not be sent', async () => {
    useApprovalsStore.setState({ pending: [approval()] });
    bridge({
      'approvals:decide': () => {
        throw fail('INTERNAL');
      },
    });
    renderLite(<ApprovalsPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(screen.getAllByTestId('approval')).toHaveLength(1));
  });

  it('is in Bengali when the app is', () => {
    useApprovalsStore.setState({ pending: [approval()] });
    renderLite(<ApprovalsPanel />, 'bn');
    expect(screen.getByRole('button', { name: 'অনুমতি দিন' })).toBeVisible();
    expect(screen.getByText(/আলেয়ার আপনার অনুমতি দরকার/)).toBeVisible();
  });
});

describe('around the tasks screen', () => {
  it('has a Tasks entry in the sidebar that opens the screen, and counts the tasks running', async () => {
    useTasksStore.setState({ tasks: [task(), task({ id: 't2', running: true })] });
    renderLite(<Sidebar />);
    expect(screen.getByRole('status', { name: '1 running' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Tasks/ }));
    expect(useAppStore.getState().route).toBe('tasks');
    expect(screen.getByRole('button', { name: /Tasks/ })).toHaveAttribute('aria-current', 'page');
  });

  it('shows no count when nothing is running', () => {
    useTasksStore.setState({ tasks: [task()] });
    renderLite(<Sidebar />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the background and notice choices in Settings', async () => {
    const invoke = bridge({
      'settings:set': (p) => ({ ...useAppStore.getState().settings, ...(p as object) }),
    });
    renderLite(<GeneralPanel />);
    const background = screen.getByRole('switch', {
      name: /Keep running in the tray when I close the window/,
    });
    expect(background).toBeChecked();
    await userEvent.click(background);
    expect(invoke).toHaveBeenCalledWith('settings:set', { background: false });
    await userEvent.click(screen.getByRole('switch', { name: /Start with Windows/ }));
    expect(invoke).toHaveBeenCalledWith('settings:set', { startWithWindows: true });
    await userEvent.click(screen.getByRole('switch', { name: /Tell me when a task finishes/ }));
    expect(invoke).toHaveBeenCalledWith('settings:set', { notifyTasks: false });
  });
});
