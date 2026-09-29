import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '@allaya/localization';
import type {
  AutomationRunView,
  AutomationTrigger,
  AutomationView,
  AutomationsOverview,
  TaskSummary,
} from '@allaya/validation';
import { AutomationsScreen } from '../../../apps/desktop/renderer/src/features/automations/automations-screen';
import {
  buildInput,
  emptyForm,
  formFrom,
  whenText,
} from '../../../apps/desktop/renderer/src/features/automations/automation-utils';
import { TasksScreen } from '../../../apps/desktop/renderer/src/features/tasks/tasks-screen';
import { useAutomationsStore } from '@renderer/stores/automations';
import { useBackendSync } from '@renderer/app/use-backend-sync';
import { useTasksStore } from '@renderer/stores/tasks';
import { useToastStore } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { renderUi } from '../../helpers/render';

const NOW = new Date(2026, 4, 4, 8, 0).getTime();
const at = (h: number, m = 0, day = 4) => new Date(2026, 4, day, h, m).getTime();

const automation = (over: Partial<AutomationView> = {}): AutomationView => ({
  id: 'auto_1',
  name: 'Morning check',
  instruction: 'List my Downloads folder',
  enabled: true,
  trigger: { kind: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] },
  options: { missed: 'skip', planFirst: false },
  nextRunAt: at(9),
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const run = (over: Partial<AutomationRunView> = {}): AutomationRunView => ({
  id: 'run_1',
  status: 'completed',
  triggeredBy: 'schedule',
  taskId: 'task_1',
  startedAt: at(9, 0, 3),
  completedAt: at(9, 1, 3),
  ...over,
});

let invoke: ReturnType<typeof vi.fn>;
let listeners: Map<string, Array<(payload: unknown) => void>>;

function bridge(
  state: { overview?: AutomationsOverview; runs?: AutomationRunView[]; folders?: string[] } = {},
  handlers: Record<string, (p: never) => unknown> = {},
) {
  listeners = new Map();
  const overview = state.overview ?? { automations: [], paused: false, limit: 20 };
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const custom = handlers[channel];
    if (custom) {
      const value = await custom(payload as never);
      if (value && typeof value === 'object' && '__error' in value) {
        return { ok: false, error: value.__error };
      }
      return { ok: true, data: value };
    }
    switch (channel) {
      case 'automations:list':
        return { ok: true, data: overview };
      case 'automations:runs':
        return { ok: true, data: state.runs ?? [] };
      case 'files:overview':
        return {
          ok: true,
          data: {
            roots: (state.folders ?? ['Documents', 'Downloads']).map((label) => ({
              id: label,
              label,
              location: `C:\\${label}`,
              origin: 'known',
              exists: true,
            })),
            recent: [],
            actions: [],
            deletesAreRestorable: false,
            accessOff: false,
          },
        };
      case 'automations:create':
      case 'automations:update':
        return { ok: true, data: automation() };
      case 'automations:runNow':
        return { ok: true, data: run({ status: 'running' }) };
      case 'tasks:list':
        return { ok: true, data: [] };
      default:
        return { ok: true, data: { ok: true } };
    }
  });
  (window as unknown as { allaya: unknown }).allaya = {
    invoke,
    subscribe: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () => undefined;
    },
  };
}
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel);
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  bridge();
  useAutomationsStore.setState({ overview: null });
  useTasksStore.setState({ byId: {}, loaded: true, selectedId: null });
  useUiStore.setState({ route: 'automations' });
});

describe('the form as data', () => {
  const form = (over = {}) => ({ ...emptyForm(NOW), name: 'N', instruction: 'Do it', ...over });

  it('builds every kind of trigger, tidily', () => {
    expect(buildInput(form({ kind: 'manual' }), NOW)).toEqual({
      ok: true,
      input: {
        name: 'N',
        instruction: 'Do it',
        trigger: { kind: 'manual' },
        options: { missed: 'skip', planFirst: false },
      },
    });
    expect(buildInput(form({ kind: 'daily', time: '18:30', days: [5, 1, 5] }), NOW)).toMatchObject({
      ok: true,
      input: { trigger: { kind: 'daily', time: '18:30', days: [1, 5] } },
    });
    expect(
      buildInput(form({ kind: 'interval', everyValue: '2', everyUnit: 'hours' }), NOW),
    ).toMatchObject({
      ok: true,
      input: { trigger: { kind: 'interval', everyMinutes: 120 } },
    });
    expect(
      buildInput(form({ kind: 'interval', everyValue: '1', everyUnit: 'days' }), NOW),
    ).toMatchObject({
      input: { trigger: { everyMinutes: 1440 } },
    });
    expect(buildInput(form({ kind: 'monthly', day: '15', time: '07:05' }), NOW)).toMatchObject({
      input: { trigger: { kind: 'monthly', day: 15, time: '07:05' } },
    });
    expect(buildInput(form({ kind: 'new_file', folder: ' Downloads ' }), NOW)).toMatchObject({
      input: { trigger: { kind: 'new_file', folder: 'Downloads' } },
    });
    const once = buildInput(form({ kind: 'once', onceAt: '2026-05-04T10:30' }), NOW);
    expect(once).toMatchObject({ ok: true, input: { trigger: { kind: 'once', at: at(10, 30) } } });
    expect(buildInput(form({ missed: 'run_once', planFirst: true }), NOW)).toMatchObject({
      input: { options: { missed: 'run_once', planFirst: true } },
    });
  });

  it('says what is wrong, field by field', () => {
    const errors = (over: object) => {
      const result = buildInput(form(over), NOW);
      return result.ok ? {} : result.errors;
    };
    expect(errors({ name: '  ' })).toEqual({ name: 'automations.form.needName' });
    expect(errors({ instruction: '' })).toEqual({
      instruction: 'automations.form.needInstruction',
    });
    expect(errors({ kind: 'once', onceAt: '2026-05-04T07:59' })).toEqual({
      onceAt: 'automations.form.past',
    });
    expect(errors({ kind: 'once', onceAt: '' })).toEqual({ onceAt: 'automations.form.past' });
    expect(errors({ kind: 'interval', everyValue: '4' })).toEqual({
      every: 'automations.form.tooOften',
    });
    expect(errors({ kind: 'interval', everyValue: '2.5', everyUnit: 'hours' })).toEqual({
      every: 'automations.form.tooOften',
    });
    expect(errors({ kind: 'interval', everyValue: '8', everyUnit: 'days' })).toEqual({
      every: 'automations.form.tooOften',
    });
    expect(errors({ kind: 'interval', everyValue: 'abc' })).toEqual({
      every: 'automations.form.tooOften',
    });
    expect(errors({ kind: 'daily', days: [] })).toEqual({ days: 'automations.form.needDays' });
    expect(errors({ kind: 'daily', time: '' })).toEqual({ time: 'automations.form.badTime' });
    expect(errors({ kind: 'monthly', day: '29' })).toEqual({ day: 'automations.form.badDay' });
    expect(errors({ kind: 'monthly', day: '0' })).toEqual({ day: 'automations.form.badDay' });
    expect(errors({ kind: 'new_file', folder: '  ' })).toEqual({
      folder: 'automations.form.needFolder',
    });
  });

  it('what was saved is what the form shows again, for every kind', () => {
    const triggers: AutomationTrigger[] = [
      { kind: 'manual' },
      { kind: 'once', at: at(11, 15) },
      { kind: 'interval', everyMinutes: 45 },
      { kind: 'interval', everyMinutes: 180 },
      { kind: 'interval', everyMinutes: 2880 },
      { kind: 'daily', time: '07:00', days: [1, 3, 5] },
      { kind: 'monthly', day: 28, time: '23:59' },
      { kind: 'new_file', folder: 'Documents/Invoices' },
    ];
    for (const trigger of triggers) {
      const shown = automation({
        trigger,
        options: { missed: 'run_once', planFirst: true },
        name: 'A',
        instruction: 'B',
      });
      const rebuilt = buildInput(formFrom(shown, NOW - 1000), NOW - 1000);
      expect(rebuilt, JSON.stringify(trigger)).toEqual({
        ok: true,
        input: {
          name: 'A',
          instruction: 'B',
          trigger,
          options: { missed: 'run_once', planFirst: true },
        },
      });
    }
  });

  it('describes when an automation starts, in both languages', () => {
    const en = createTranslator({ locale: 'en' });
    const bn = createTranslator({ locale: 'bn' });
    const cases: Array<[AutomationView['trigger'], string]> = [
      [{ kind: 'manual' }, 'Only when you run it'],
      [{ kind: 'interval', everyMinutes: 30 }, 'Every 30 minutes'],
      [{ kind: 'interval', everyMinutes: 60 }, 'Every hour'],
      [{ kind: 'interval', everyMinutes: 240 }, 'Every 4 hours'],
      [{ kind: 'interval', everyMinutes: 1440 }, 'Every day'],
      [{ kind: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, 'Every day at 09:00'],
      [{ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, 'Weekdays at 09:00'],
      [{ kind: 'daily', time: '10:00', days: [0, 6] }, 'Weekends at 10:00'],
      [{ kind: 'daily', time: '18:00', days: [1, 3] }, 'Every Monday, Wednesday at 18:00'],
      [{ kind: 'monthly', day: 5, time: '08:00' }, 'On day 5 of every month at 08:00'],
      [{ kind: 'new_file', folder: 'Downloads' }, 'When a new file appears in “Downloads”'],
    ];
    for (const [trigger, expected] of cases) {
      expect(whenText(trigger, en)).toBe(expected);
      expect(whenText(trigger, bn)).toMatch(/[\u0980-\u09FF]/);
    }
    expect(whenText({ kind: 'once', at: at(9) }, en)).toMatch(/^Once, on /);
  });
});

describe('Automations screen — the list', () => {
  it('shows an empty state that offers to create the first one', async () => {
    renderUi(<AutomationsScreen />);
    expect(await screen.findByText('No automations yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Automation' })).toBeInTheDocument();
  });

  it('shows each automation with when it runs, when next, and how the last run went', async () => {
    bridge({
      overview: {
        automations: [
          automation({ lastRun: run({ status: 'failed' }), lastRunAt: at(9, 0, 3) }),
          automation({
            id: 'auto_2',
            name: 'Watch Downloads',
            instruction: 'Tell me what arrived',
            trigger: { kind: 'new_file', folder: 'Downloads' },
            nextRunAt: undefined,
            enabled: false,
          }),
        ],
        paused: false,
        limit: 20,
      },
    });
    renderUi(<AutomationsScreen />);
    const cards = await screen.findAllByTestId('automation-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByRole('heading', { name: 'Morning check' })).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Every day at 09:00')).toBeInTheDocument();
    expect(within(cards[0]!).getByText(/Next run:/)).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Failed')).toBeInTheDocument();
    expect(
      within(cards[0]!).getByRole('switch', { name: 'Run “Morning check” automatically' }),
    ).toBeChecked();
    expect(
      within(cards[1]!).getByText('When a new file appears in “Downloads”'),
    ).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Has not run yet')).toBeInTheDocument();
    expect(within(cards[1]!).queryByText(/Next run:/)).not.toBeInTheDocument();
    expect(within(cards[1]!).getByRole('switch')).not.toBeChecked();
  });

  it('tells the person about a problem, in words', async () => {
    bridge({
      overview: {
        automations: [
          automation({ enabled: false, problem: 'too_many_failures', consecutiveFailures: 3 }),
          automation({ id: 'auto_2', name: 'Watcher', problem: 'cannot_watch' }),
        ],
        paused: false,
        limit: 20,
      },
    });
    renderUi(<AutomationsScreen />);
    expect(
      await screen.findByText(/switched off after 3 runs failed in a row/),
    ).toBeInTheDocument();
    expect(screen.getByText(/can't read this folder right now/)).toBeInTheDocument();
  });

  it('says loudly that the emergency stop paused everything, and lets the person turn it back on', async () => {
    bridge({ overview: { automations: [automation()], paused: true, limit: 20 } });
    renderUi(<AutomationsScreen />);
    expect(await screen.findByText('Automations are paused')).toBeInTheDocument();
    expect(screen.getByText(/You pressed STOP/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn automations back on' }));
    await waitFor(() =>
      expect(calls('automations:setPaused')).toEqual([
        ['automations:setPaused', { paused: false }],
      ]),
    );
  });

  it('will not offer a twenty-first', async () => {
    const many = Array.from({ length: 20 }, (_, i) => automation({ id: `a${i}`, name: `A${i}` }));
    bridge({ overview: { automations: many, paused: false, limit: 20 } });
    renderUi(<AutomationsScreen />);
    expect(await screen.findByText('You can have up to 20 automations.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New automation' })).toBeDisabled();
  });

  it('switches one on or off', async () => {
    bridge({ overview: { automations: [automation()], paused: false, limit: 20 } });
    renderUi(<AutomationsScreen />);
    await userEvent.click(
      await screen.findByRole('switch', { name: 'Run “Morning check” automatically' }),
    );
    await waitFor(() =>
      expect(calls('automations:setEnabled')).toEqual([
        ['automations:setEnabled', { id: 'auto_1', enabled: false }],
      ]),
    );
  });

  it('runs one now and says it started', async () => {
    bridge({ overview: { automations: [automation()], paused: false, limit: 20 } });
    renderUi(<AutomationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() =>
      expect(calls('automations:runNow')).toEqual([['automations:runNow', { id: 'auto_1' }]]),
    );
    await waitFor(() => expect(toasts()).toContain('Started “Morning check”'));
  });

  it('reports a refusal in the person’s language', async () => {
    bridge(
      { overview: { automations: [automation()], paused: false, limit: 20 } },
      {
        'automations:runNow': () => ({
          __error: { code: 'NOT_FOUND', message: 'x', retryable: false },
        }),
      },
    );
    renderUi(<AutomationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(toasts()).toContain('That no longer exists.'));
  });

  it('shows the history of runs — what happened, why nothing started, and a way to the task', async () => {
    bridge({
      overview: { automations: [automation()], paused: false, limit: 20 },
      runs: [
        run({
          id: 'r3',
          status: 'skipped',
          taskId: undefined,
          note: 'missed',
          triggeredBy: 'schedule',
        }),
        run({
          id: 'r2',
          status: 'failed',
          error: 'The folder is not there.',
          triggeredBy: 'manual',
          taskId: 'task_2',
        }),
        run({ id: 'r1', status: 'completed', note: 'partial', triggeredBy: 'event' }),
      ],
    });
    renderUi(<AutomationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText(/Allaya was closed at that time/)).toBeInTheDocument();
    expect(screen.getByText('The folder is not there.')).toBeInTheDocument();
    expect(screen.getByText('By you')).toBeInTheDocument();
    expect(screen.getByText('A new file appeared')).toBeInTheDocument();
    expect(screen.getByText(/Only partly done/)).toBeInTheDocument();
    // The task behind a run is one click away.
    const open = screen.getAllByRole('button', { name: 'Open task' });
    expect(open).toHaveLength(2); // the skipped run started nothing
    await userEvent.click(open[0]!);
    expect(useUiStore.getState().route).toBe('tasks');
    expect(useTasksStore.getState().selectedId).toBe('task_2');
  });

  it('says so when nothing has run yet', async () => {
    bridge({ overview: { automations: [automation()], paused: false, limit: 20 }, runs: [] });
    renderUi(<AutomationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText('Nothing has run yet.')).toBeInTheDocument();
  });

  it('asks before deleting, and says what is kept', async () => {
    bridge({ overview: { automations: [automation()], paused: false, limit: 20 } });
    renderUi(<AutomationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete automation' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Tasks it already ran stay in Tasks/)).toBeInTheDocument();
    expect(calls('automations:delete')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(calls('automations:delete')).toEqual([['automations:delete', { id: 'auto_1' }]]),
    );
    await waitFor(() => expect(toasts()).toContain('Deleted “Morning check”'));
  });

  it('speaks Bengali when the interface is Bengali', async () => {
    bridge({
      overview: { automations: [automation({ lastRun: run() })], paused: false, limit: 20 },
    });
    renderUi(<AutomationsScreen />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByText('প্রতিদিন 09:00-এ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'এখনই চালান' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'নতুন স্বয়ংক্রিয় কাজ' })).toBeInTheDocument();
  });
});

describe('Automations screen — the form', () => {
  const open = async () => {
    renderUi(<AutomationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'New automation' }));
    return screen.findByRole('dialog');
  };

  it('creates an automation from plain words and a time of day', async () => {
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Morning check');
    await userEvent.type(
      within(dialog).getByLabelText('What should Allaya do?'),
      'List my Downloads folder',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('automations:create')).toHaveLength(1));
    expect(calls('automations:create')[0]![1]).toEqual({
      name: 'Morning check',
      instruction: 'List my Downloads folder',
      trigger: { kind: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] },
      options: { missed: 'skip', planFirst: false },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('will not save until it makes sense, and says what is missing', async () => {
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Give it a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Say what Allaya should do.')).toBeInTheDocument();
    expect(calls('automations:create')).toHaveLength(0);
    // Every weekday switched off is not a schedule.
    await userEvent.type(within(dialog).getByLabelText('Name'), 'N');
    await userEvent.type(within(dialog).getByLabelText('What should Allaya do?'), 'Do it');
    for (const day of [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ]) {
      await userEvent.click(within(dialog).getByRole('button', { name: day }));
    }
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Choose at least one day.')).toBeInTheDocument();
    expect(calls('automations:create')).toHaveLength(0);
  });

  it('shows the fields of the chosen kind of trigger, and builds it', async () => {
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Watcher');
    await userEvent.type(
      within(dialog).getByLabelText('What should Allaya do?'),
      'Tell me what arrived',
    );
    await userEvent.selectOptions(within(dialog).getByLabelText('When should it run?'), 'new_file');
    expect(within(dialog).queryByLabelText('Time')).not.toBeInTheDocument();
    // Missed-run policy is meaningless for a folder watch.
    expect(
      within(dialog).queryByLabelText('If Allaya was closed when it should have run'),
    ).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Folder'), 'Downloads');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('automations:create')).toHaveLength(1));
    expect(calls('automations:create')[0]![1]).toMatchObject({
      trigger: { kind: 'new_file', folder: 'Downloads' },
    });
  });

  it('builds an interval and passes the options the person chose', async () => {
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Often');
    await userEvent.type(within(dialog).getByLabelText('What should Allaya do?'), 'Check');
    await userEvent.selectOptions(within(dialog).getByLabelText('When should it run?'), 'interval');
    const every = within(dialog).getByRole('spinbutton');
    await userEvent.clear(every);
    await userEvent.type(every, '2');
    await userEvent.selectOptions(within(dialog).getAllByLabelText('Every').at(-1)!, 'hours');
    await userEvent.selectOptions(
      within(dialog).getByLabelText('If Allaya was closed when it should have run'),
      'run_once',
    );
    await userEvent.click(
      within(dialog).getByRole('switch', { name: 'Show me the plan of each run before it starts' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('automations:create')).toHaveLength(1));
    expect(calls('automations:create')[0]![1]).toMatchObject({
      trigger: { kind: 'interval', everyMinutes: 120 },
      options: { missed: 'run_once', planFirst: true },
    });
  });

  it('keeps the dialog open and explains a refusal from the backend', async () => {
    bridge(
      {},
      {
        'automations:create': () => ({
          __error: {
            code: 'INVALID_INPUT',
            message: 'x',
            retryable: false,
            details: { reason: 'in_the_past' },
          },
        }),
      },
    );
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'N');
    await userEvent.type(within(dialog).getByLabelText('What should Allaya do?'), 'Do it');
    // (The time looks fine here — an hour ahead — but the backend's clock says it has passed.)
    await userEvent.selectOptions(within(dialog).getByLabelText('When should it run?'), 'once');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('That time has already passed.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('suggests the folders Allaya may use', async () => {
    const dialog = await open();
    await userEvent.selectOptions(within(dialog).getByLabelText('When should it run?'), 'new_file');
    const list = dialog.querySelector('datalist')!;
    expect([...list.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual([
      'Documents',
      'Downloads',
    ]);
  });

  it('edits an existing one, starting from what it has', async () => {
    bridge({
      overview: {
        automations: [
          automation({
            trigger: { kind: 'daily', time: '07:30', days: [1, 3] },
            options: { missed: 'run_once', planFirst: true },
          }),
        ],
        paused: false,
        limit: 20,
      },
    });
    renderUi(<AutomationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit automation' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Morning check');
    expect(within(dialog).getByLabelText('Time')).toHaveValue('07:30');
    expect(within(dialog).getByRole('button', { name: 'Monday' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: 'Tuesday' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Renamed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('automations:update')).toHaveLength(1));
    expect(calls('automations:update')[0]![1]).toEqual({
      id: 'auto_1',
      changes: {
        name: 'Renamed',
        instruction: 'List my Downloads folder',
        trigger: { kind: 'daily', time: '07:30', days: [1, 3] },
        options: { missed: 'run_once', planFirst: true },
      },
    });
  });

  it('starts empty again the next time it is opened', async () => {
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Half typed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'New automation' }));
    expect(await screen.findByLabelText('Name')).toHaveValue('');
  });
});

describe('automations elsewhere in the app', () => {
  it('the Tasks screen has a Scheduled tab for what automations started', async () => {
    const task = (id: string, source: TaskSummary['source']): TaskSummary => ({
      id,
      title: id,
      state: 'COMPLETED',
      phase: 'COMPLETED',
      source,
      language: 'en',
      planFirst: false,
      riskLevel: 'LOW',
      filesChanged: 0,
      actionCount: 0,
      stepCount: 1,
      stepsDone: 1,
      running: false,
      queued: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    useTasksStore.setState({
      byId: { a: task('From an automation', 'automation'), b: task('From chat', 'chat') },
      loaded: true,
      selectedId: null,
    });
    renderUi(<TasksScreen />);
    const tabs = await screen.findByRole('tablist', { name: 'Filter tasks' });
    const scheduled = within(tabs).getByRole('tab', { name: /Scheduled/ });
    expect(scheduled).toHaveTextContent('1');
    await userEvent.click(scheduled);
    const list = screen.getByRole('list', { name: 'Tasks' });
    expect(within(list).getByText('From an automation')).toBeInTheDocument();
    expect(within(list).queryByText('From chat')).not.toBeInTheDocument();
  });

  it('reloads when the backend says automations changed', async () => {
    function Probe() {
      useBackendSync();
      return null;
    }
    bridge({ overview: { automations: [automation()], paused: false, limit: 20 } });
    renderUi(<Probe />);
    await waitFor(() => expect(calls('automations:list').length).toBeGreaterThanOrEqual(0));
    const before = calls('automations:list').length;
    act(() => listeners.get('automations:changed')!.forEach((listener) => listener({})));
    await waitFor(() => expect(calls('automations:list').length).toBe(before + 1));
    expect(useAutomationsStore.getState().overview?.automations).toHaveLength(1);
  });
});
