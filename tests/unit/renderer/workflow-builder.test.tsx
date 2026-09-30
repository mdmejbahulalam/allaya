import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '@allaya/localization';
import type {
  AutomationRunView,
  AutomationView,
  AutomationsOverview,
  Workflow,
  WorkflowStep,
} from '@allaya/validation';
import { AutomationsScreen } from '../../../apps/desktop/renderer/src/features/automations/automations-screen';
import {
  buildInput,
  conditionText,
  emptyForm,
  formFrom,
  outline,
} from '../../../apps/desktop/renderer/src/features/automations/automation-utils';
import { useAutomationsStore } from '@renderer/stores/automations';
import { useToastStore } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { renderUi } from '../../helpers/render';

const NOW = new Date(2026, 4, 4, 8, 0).getTime();
const en = createTranslator({ locale: 'en' });
const bn = createTranslator({ locale: 'bn' });

const act = (id: string, instruction: string, extra: Partial<WorkflowStep> = {}) =>
  ({ type: 'action', id, instruction, ...extra }) as WorkflowStep;
const sample: Workflow = {
  steps: [
    act('a', 'Sort my Downloads', { label: 'Sort' }),
    {
      type: 'condition',
      id: 'c',
      if: { kind: 'previous', is: 'failed' },
      then: [act('t', 'Tell me it failed')],
      else: [act('e', 'Tell me it worked')],
    },
    { type: 'loop', id: 'l', over: { kind: 'times', times: 2 }, body: [act('b', 'Tidy')] },
    { type: 'approval', id: 'p', message: 'Send the report?' },
    { type: 'stop', id: 's' },
  ],
};

const automation = (over: Partial<AutomationView> = {}): AutomationView => ({
  id: 'auto_1',
  name: 'Downloads flow',
  instruction: '',
  workflow: sample,
  enabled: true,
  trigger: { kind: 'manual' },
  options: { missed: 'skip', planFirst: false },
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const run = (over: Partial<AutomationRunView> = {}): AutomationRunView => ({
  id: 'run_1',
  status: 'running',
  triggeredBy: 'manual',
  startedAt: NOW,
  ...over,
});

let invoke: ReturnType<typeof vi.fn>;
function bridge(
  automations: AutomationView[] = [],
  handlers: Record<string, (p: never) => unknown> = {},
  runs: AutomationRunView[] = [],
) {
  const overview: AutomationsOverview = { automations, paused: false, limit: 20 };
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const custom = handlers[channel];
    if (custom) {
      const value = await custom(payload as never);
      if (value && typeof value === 'object' && '__error' in value)
        return { ok: false, error: value.__error };
      return { ok: true, data: value };
    }
    switch (channel) {
      case 'automations:list':
        return { ok: true, data: overview };
      case 'automations:runs':
        return { ok: true, data: runs };
      case 'files:overview':
        return {
          ok: true,
          data: {
            roots: [
              { id: 'd', label: 'Downloads', location: 'C:\\D', origin: 'known', exists: true },
            ],
            recent: [],
            actions: [],
            deletesAreRestorable: false,
            accessOff: false,
          },
        };
      case 'automations:create':
      case 'automations:update':
        return { ok: true, data: automation() };
      default:
        return { ok: true, data: run() };
    }
  });
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel);
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  bridge();
  useAutomationsStore.setState({ overview: null });
  useUiStore.setState({ route: 'automations' });
  useToastStore.setState({ toasts: [] });
});

// ── the form as data ────────────────────────────────────────────────────────
describe('the form for a workflow, as data', () => {
  const form = (over = {}) => ({
    ...emptyForm(NOW),
    name: 'N',
    kind: 'manual' as const,
    mode: 'workflow' as const,
    steps: sample.steps,
    ...over,
  });

  it('sends the steps and no instruction, with empty labels dropped and text trimmed', () => {
    const result = buildInput(
      form({ instruction: 'typed earlier', steps: [act('a', '  Do it  ', { label: '  ' })] }),
      NOW,
    );
    expect(result).toEqual({
      ok: true,
      input: {
        name: 'N',
        instruction: '',
        workflow: { steps: [{ type: 'action', id: 'a', instruction: 'Do it' }] },
        trigger: { kind: 'manual' },
        options: { missed: 'skip', planFirst: false },
      },
    });
  });

  it('a single instruction still needs its text; a workflow needs a workable set of steps instead', () => {
    expect(buildInput({ ...emptyForm(NOW), name: 'N', kind: 'manual' }, NOW)).toMatchObject({
      ok: false,
      errors: { instruction: 'automations.form.needInstruction' },
    });
    expect(buildInput(form({ steps: [] }), NOW)).toMatchObject({
      ok: false,
      errors: { workflow: 'automations.workflow.invalid' },
      problem: { problem: 'nothing_to_do' },
    });
    expect(buildInput(form({ steps: [act('a', '  ')] }), NOW)).toMatchObject({
      ok: false,
      problem: { problem: 'empty_text', stepId: 'a' },
    });
    expect(
      buildInput(
        form({
          kind: 'daily',
          steps: [{ type: 'loop', id: 'l', over: { kind: 'files' }, body: [act('a', 'x')] }],
        }),
        NOW,
      ),
    ).toMatchObject({ ok: false, problem: { problem: 'files_loop_needs_folder', stepId: 'l' } });
  });

  it('shows a saved workflow again as it was saved, and copies it (editing never changes the original)', () => {
    const view = automation();
    const back = formFrom(view, NOW);
    expect(back).toMatchObject({ mode: 'workflow', steps: sample.steps });
    back.steps.push(act('z', 'extra'));
    expect(view.workflow!.steps).toHaveLength(5);
    expect(formFrom(automation({ workflow: undefined, instruction: 'x' }), NOW).mode).toBe(
      'single',
    );
  });

  it('describes a workflow in short indented lines, in both languages', () => {
    const lines = outline(sample.steps, en).map((l) => `${l.depth}:${l.text}`);
    expect(lines).toEqual([
      '0:Sort',
      '0:If the previous step failed',
      '1:Tell me it failed',
      '0:Otherwise',
      '1:Tell me it worked',
      '0:Repeat 2 times',
      '1:Tidy',
      '0:Ask me: Send the report?',
      '0:Stop here',
    ]);
    expect(outline(sample.steps, bn)[1]!.text).toMatch(/আগের ধাপ ব্যর্থ/);
    expect(conditionText({ kind: 'weekday', days: [1, 3] }, en)).toBe('it is Monday, Wednesday');
    expect(conditionText({ kind: 'time_between', from: '22:00', to: '06:00' }, en)).toBe(
      'the time is between 22:00 and 06:00',
    );
    expect(conditionText({ kind: 'summary', contains: 'invoice' }, en)).toBe(
      'the previous step said “invoice”',
    );
  });
});

// ── the builder ─────────────────────────────────────────────────────────────
async function openNew() {
  renderUi(<AutomationsScreen />);
  await userEvent.click(await screen.findByRole('button', { name: 'New automation' }));
  return screen.findByRole('dialog');
}
const switchToSteps = async () =>
  userEvent.click(screen.getByRole('radio', { name: 'Several steps' }));
/** A lane's own "add" buttons come after its steps (and their nested lanes), so the last match is the lane's own. */
const addButton = (name: string, scope?: HTMLElement) =>
  within(scope ?? screen.getByRole('dialog'))
    .getAllByRole('button', { name })
    .at(-1)!;
const steps = () => screen.queryAllByTestId('workflow-step');

describe('building a workflow on the screen', () => {
  it('starts from what was typed, so switching to steps loses nothing', async () => {
    const dialog = await openNew();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'What should Allaya do?' }),
      'List my Downloads',
    );
    await switchToSteps();
    expect(steps()).toHaveLength(1);
    expect(
      within(steps()[0]!).getByRole('textbox', { name: 'What should Allaya do?' }),
    ).toHaveValue('List my Downloads');
    // …and back again: the single instruction is still there.
    await userEvent.click(screen.getByRole('radio', { name: 'One instruction' }));
    expect(screen.getByRole('textbox', { name: 'What should Allaya do?' })).toHaveValue(
      'List my Downloads',
    );
  });

  it('adds each kind of step, fills them in, and saves exactly that workflow', async () => {
    bridge();
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Flow');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'When should it run?' }));
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'When should it run?' }),
      'manual',
    );
    await switchToSteps();

    await userEvent.type(
      within(steps()[0]!).getByRole('textbox', { name: 'What should Allaya do?' }),
      'Sort my Downloads',
    );
    await userEvent.click(addButton('If…'));
    const condition = steps()[1]!;
    await userEvent.selectOptions(
      within(condition).getByRole('combobox', { name: 'Look at' }),
      'summary',
    );
    await userEvent.type(
      within(condition).getByRole('textbox', { name: 'Text to look for' }),
      'invoice',
    );
    await userEvent.click(
      addButton(
        'Do something',
        within(condition).getByRole('group', { name: 'Steps to do if step 2 is met' }),
      ),
    );
    await userEvent.type(
      within(
        within(condition).getByRole('group', { name: 'Steps to do if step 2 is met' }),
      ).getByRole('textbox', { name: 'What should Allaya do?' }),
      'File the invoice',
    );
    await userEvent.click(addButton('Ask me first'));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'What should Allaya ask you?' }),
      'Send it?',
    );
    await userEvent.click(addButton('Stop here'));

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('automations:create')).toHaveLength(1));
    const sent = calls('automations:create')[0]![1] as { workflow: Workflow; instruction: string };
    expect(sent.instruction).toBe('');
    expect(sent.workflow.steps.map((s) => s.type)).toEqual([
      'action',
      'condition',
      'approval',
      'stop',
    ]);
    expect(sent.workflow.steps[0]).toMatchObject({ instruction: 'Sort my Downloads' });
    expect(sent.workflow.steps[1]).toMatchObject({
      if: { kind: 'summary', contains: 'invoice' },
      then: [{ type: 'action', instruction: 'File the invoice' }],
      else: [],
    });
    expect(sent.workflow.steps[2]).toMatchObject({ message: 'Send it?' });
    expect(new Set(sent.workflow.steps.map((s) => s.id)).size).toBe(4);
  });

  it('every step is reachable by name for a screen reader, with its number and kind', async () => {
    await openNew();
    await switchToSteps();
    await userEvent.click(addButton('Repeat'));
    expect(screen.getByRole('region', { name: 'Step 2: Repeat' })).toBeInTheDocument();
    const inside = screen.getByRole('group', { name: 'Steps inside step 2' });
    expect(within(inside).getAllByTestId('workflow-step')).toHaveLength(1);
  });

  it('moves a step up and down, and removes one', async () => {
    await openNew();
    await switchToSteps();
    await userEvent.click(addButton('Ask me first'));
    await userEvent.click(addButton('Stop here'));
    const order = () => steps().map((s) => s.getAttribute('data-step-type'));
    expect(order()).toEqual(['action', 'approval', 'stop']);
    expect(screen.getByRole('button', { name: 'Move step 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move step 3 down' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Move step 3 up' }));
    expect(order()).toEqual(['action', 'stop', 'approval']);
    await userEvent.click(screen.getByRole('button', { name: 'Remove step 2' }));
    expect(order()).toEqual(['action', 'approval']);
  });

  it('offers "for each new file" only when a folder starts the automation', async () => {
    const dialog = await openNew();
    await switchToSteps();
    await userEvent.click(addButton('Repeat'));
    const loop = steps()[1]!;
    const option = within(loop).getByRole('option', { name: 'Once for each new file' });
    expect(option).toBeDisabled();
    expect(
      within(loop).getByText(/works when the automation starts on a new file/),
    ).toBeInTheDocument();
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'When should it run?' }),
      'new_file',
    );
    expect(
      within(steps()[1]!).getByRole('option', { name: 'Once for each new file' }),
    ).toBeEnabled();
  });

  it('stops offering nesting past three levels (a step in the third level may only do something)', async () => {
    await openNew();
    await switchToSteps();
    // Level 1: the top. A repeat there has its steps on level 2; a repeat inside that, on level 3.
    await userEvent.click(addButton('Repeat'));
    const first = steps()[1]!;
    const levelTwo = within(first).getByRole('group', { name: 'Steps inside step 2' });
    expect(within(levelTwo).getAllByRole('button', { name: 'Repeat' }).at(-1)).toBeEnabled();
    await userEvent.click(within(levelTwo).getAllByRole('button', { name: 'Repeat' }).at(-1)!);
    const second = within(first).getAllByTestId('workflow-step')[1]!;
    const levelThree = within(second).getByRole('group', { name: /Steps inside step/ });
    expect(within(levelThree).getByRole('button', { name: 'If…' })).toBeDisabled();
    expect(within(levelThree).getByRole('button', { name: 'Repeat' })).toBeDisabled();
    expect(within(levelThree).getByRole('button', { name: 'Do something' })).toBeEnabled();
    expect(within(levelThree).getByRole('button', { name: 'Ask me first' })).toBeEnabled();
  });

  it('stops offering more at thirty steps', async () => {
    await openNew();
    await switchToSteps();
    for (let i = 0; i < 29; i += 1) await userEvent.click(addButton('Stop here'));
    expect(steps()).toHaveLength(30);
    for (const name of ['Do something', 'If…', 'Repeat', 'Ask me first', 'Stop here']) {
      expect(addButton(name)).toBeDisabled();
    }
    await userEvent.click(screen.getByRole('button', { name: 'Remove step 30' }));
    expect(addButton('Stop here')).toBeEnabled();
  });

  it('points at the step that is wrong, and sends nothing', async () => {
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Flow');
    await switchToSteps();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(steps()[0]!).findByText('Fill this in.')).toBeInTheDocument();
    expect(calls('automations:create')).toHaveLength(0);
    // Typing clears the marks.
    await userEvent.type(
      within(steps()[0]!).getByRole('textbox', { name: 'What should Allaya do?' }),
      'x',
    );
    expect(within(steps()[0]!).queryByText('Fill this in.')).not.toBeInTheDocument();
  });

  it('says what the backend refused, in words', async () => {
    bridge([], {
      'automations:create': () => ({
        __error: { code: 'INVALID_INPUT', message: 'x', details: { reason: 'nothing_to_do' } },
      }),
    });
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Flow');
    await switchToSteps();
    await userEvent.type(
      within(steps()[0]!).getByRole('textbox', { name: 'What should Allaya do?' }),
      'x',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Add at least one “Do something” step.')).toBeInTheDocument();
  });

  it('edits a saved workflow: it is shown as saved, and saves back the changes', async () => {
    bridge([automation()]);
    renderUi(<AutomationsScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Several steps' })).toBeChecked();
    expect(steps().length).toBeGreaterThanOrEqual(5);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove step 5' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('automations:update')).toHaveLength(1));
    const changes = (calls('automations:update')[0]![1] as { changes: { workflow: Workflow } })
      .changes;
    expect(changes.workflow.steps.map((s) => s.type)).toEqual([
      'action',
      'condition',
      'loop',
      'approval',
    ]);
  });

  it('is in Bengali when the interface is', async () => {
    renderUi(<AutomationsScreen />, { settings: { 'language.ui': 'bn' } });
    await userEvent.click(await screen.findByRole('button', { name: bn.t('automations.new') }));
    await userEvent.click(
      screen.getByRole('radio', { name: bn.t('automations.workflow.mode.workflow') }),
    );
    expect(
      screen.getByRole('button', { name: bn.t('automations.workflow.add.approval') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', {
        name: bn.t('automations.workflow.stepLabel', {
          n: 1,
          type: bn.t('automations.workflow.step.action'),
        }),
      }),
    ).toBeInTheDocument();
  });
});

// ── the card and its runs ───────────────────────────────────────────────────
describe('a workflow on its card', () => {
  it('shows that it has steps and lists them, indented', async () => {
    bridge([automation()]);
    renderUi(<AutomationsScreen />);
    const card = await screen.findByTestId('automation-card');
    expect(within(card).getByText('8 steps')).toBeInTheDocument();
    await userEvent.click(within(card).getByText(/Steps/, { selector: 'summary *, summary' }));
    expect(within(card).getByText(/Tell me it failed/)).toBeInTheDocument();
    expect(within(card).getByText(/Ask me: Send the report\?/)).toBeInTheDocument();
  });

  it('asks the person to approve a waiting step, whichever run it is, and sends their answer', async () => {
    const waiting = run({
      id: 'run_w',
      status: 'waiting_for_approval',
      note: 'approval',
      approval: { message: 'Send the report?' },
      progress: { steps: 1, current: 'Send the report?' },
    });
    // The newest run is a skipped one; the waiting run is an older one.
    bridge([
      automation({
        lastRun: run({ id: 'run_new', status: 'skipped', note: 'still_running' }),
        awaiting: waiting,
      }),
    ]);
    renderUi(<AutomationsScreen />);
    const ask = await screen.findByTestId('approval-ask');
    expect(within(ask).getByText('Send the report?')).toBeInTheDocument();
    await userEvent.click(within(ask).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls('automations:decide')).toHaveLength(1));
    expect(calls('automations:decide')[0]![1]).toEqual({ runId: 'run_w', approve: true });
    expect(toasts()).toContain('Approved. “Downloads flow” is going on.');
  });

  it('sends "no" too, and reports a refusal instead of failing silently', async () => {
    const waiting = run({
      id: 'run_w',
      status: 'waiting_for_approval',
      note: 'approval',
      approval: { message: 'OK?' },
    });
    bridge([automation({ awaiting: waiting })], {
      'automations:decide': () => ({ __error: { code: 'INVALID_INPUT', message: 'x' } }),
    });
    renderUi(<AutomationsScreen />);
    await userEvent.click(
      within(await screen.findByTestId('approval-ask')).getByRole('button', { name: 'Decline' }),
    );
    await waitFor(() =>
      expect(calls('automations:decide')[0]![1]).toEqual({ runId: 'run_w', approve: false }),
    );
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0));
    expect(toasts()).not.toContain('Declined. “Downloads flow” was ended.');
  });

  it('shows no approval prompt when nothing is waiting', async () => {
    bridge([
      automation({ lastRun: run({ status: 'running', progress: { steps: 2, current: 'Tidy' } }) }),
    ]);
    renderUi(<AutomationsScreen />);
    await screen.findByTestId('automation-card');
    expect(screen.queryByTestId('approval-ask')).not.toBeInTheDocument();
  });

  it('shows progress and the reason in the history', async () => {
    bridge([automation()], {}, [
      run({
        id: 'r3',
        status: 'cancelled',
        note: 'declined',
        progress: { steps: 1, current: 'Send the report?' },
      }),
      run({
        id: 'r2',
        status: 'failed',
        note: 'step_limit',
        progress: { steps: 50, current: 'Tidy' },
      }),
      run({
        id: 'r1',
        status: 'completed',
        note: 'ended_early',
        progress: { steps: 2, current: 'Check' },
      }),
    ]);
    renderUi(<AutomationsScreen />);
    const card = await screen.findByTestId('automation-card');
    await userEvent.click(within(card).getByRole('button', { name: 'History' }));
    expect(await within(card).findByText('— You said no')).toBeInTheDocument();
    expect(within(card).getByText('— Stopped: too many steps in one run')).toBeInTheDocument();
    expect(within(card).getByText('— Ended early, as planned')).toBeInTheDocument();
    expect(within(card).getByText('Step 50: Tidy')).toBeInTheDocument();
  });
});
