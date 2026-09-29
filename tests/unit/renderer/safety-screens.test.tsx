import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_SUBJECTS, SENSITIVE_ACTIONS } from '@allaya/types';
import type { ActivityEntry, EmergencyStopStatus, PermissionEntry } from '@allaya/validation';
import { ActivityScreen } from '../../../apps/desktop/renderer/src/features/activity/activity-screen';
import { PermissionsScreen } from '../../../apps/desktop/renderer/src/features/permissions/permissions-screen';
import { useSafetyStore } from '@renderer/stores/safety';
import { useToastStore } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { renderUi } from '../../helpers/render';

const DEFAULTS: Record<string, 'ask' | 'never'> = {
  camera: 'never',
  administrator_commands: 'never',
};
const entries = (over: Record<string, PermissionEntry['mode']> = {}): PermissionEntry[] =>
  PERMISSION_SUBJECTS.map((subject) => ({
    subject,
    mode: over[subject] ?? DEFAULTS[subject] ?? 'ask',
    defaultMode: DEFAULTS[subject] ?? 'ask',
    sensitive: (SENSITIVE_ACTIONS as readonly string[]).includes(subject),
  }));

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'a1',
  timestamp: new Date(2026, 4, 4, 9, 30).getTime(),
  actor: 'allaya',
  tool: 'get_datetime',
  action: 'Read the clock',
  result: 'success',
  risk: 'LOW',
  permission: 'not_required',
  ...over,
});

let invoke: ReturnType<typeof vi.fn>;
type Handlers = Record<string, (p: never) => unknown>;
function bridge(handlers: Handlers = {}) {
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
      case 'permissions:list':
      case 'permissions:reset':
        return { ok: true, data: entries() };
      case 'agent:getSafety':
        return {
          ok: true,
          data: { emergencyStop: { accelerator: 'Ctrl+Shift+Escape', registered: true } },
        };
      case 'activity:list':
        return { ok: true, data: { entries: [], hasMore: false, retentionDays: 90 } };
      default:
        return { ok: true, data: { ok: true } };
    }
  });
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel);
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);
const safety = (over: Partial<EmergencyStopStatus>): EmergencyStopStatus => ({
  accelerator: 'Ctrl+Shift+Escape',
  registered: true,
  ...over,
});

beforeEach(() => {
  bridge();
  useSafetyStore.setState({ activityVersion: 0, safetyVersion: 0 });
  useUiStore.setState({ route: 'permissions' });
});

describe('the Permissions screen', () => {
  it('lists every capability and sensitive action with what it means, and its setting', async () => {
    bridge({
      'permissions:list': () => entries({ file_access: 'always_allow', clipboard: 'never' }),
    });
    renderUi(<PermissionsScreen />);
    const rows = await screen.findAllByTestId('permission-row');
    expect(rows).toHaveLength(PERMISSION_SUBJECTS.length);
    const files = within(screen.getByRole('list', { name: 'Capabilities' })).getAllByTestId(
      'permission-row',
    )[1]!;
    expect(within(files).getByRole('heading', { name: 'File access' })).toBeInTheDocument();
    expect(within(files).getByText('Changed')).toBeInTheDocument();
    expect(within(files).getByRole('combobox', { name: 'Setting for File access' })).toHaveValue(
      'always_allow',
    );
    expect(within(files).getByText(/in the folders you allowed/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Setting for Camera' })).toHaveValue('never');
    expect(screen.getByText(/always need a click on the screen/)).toBeInTheDocument();
  });

  it('sensitive actions cannot be offered "always allow", and say why', async () => {
    renderUi(<PermissionsScreen />);
    await screen.findAllByTestId('permission-row');
    const list = screen.getByRole('list', { name: 'Sensitive actions' });
    for (const row of within(list).getAllByTestId('permission-row')) {
      const options = within(row)
        .getAllByRole('option')
        .map((o) => o.textContent);
      expect(options).toEqual(['Ask every time', 'Never allow']);
    }
    expect(screen.getByText(/can't be set to always allow/)).toBeInTheDocument();
    const capabilityOptions = within(
      screen.getByRole('combobox', { name: 'Setting for Clipboard' }),
    )
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(capabilityOptions).toEqual(['Always allow', 'Ask every time', 'Never allow']);
  });

  it('changes a setting through the backend and shows what came back', async () => {
    bridge({
      'permissions:set': ({ subject, mode }: never) => entries({ [subject as string]: mode }),
    });
    renderUi(<PermissionsScreen />);
    await screen.findAllByTestId('permission-row');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Setting for Clipboard' }),
      'never',
    );
    await waitFor(() =>
      expect(calls('permissions:set')).toEqual([
        ['permissions:set', { subject: 'clipboard', mode: 'never' }],
      ]),
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Setting for Clipboard' })).toHaveValue('never'),
    );
  });

  it('says so when a change is refused, and leaves the setting as it was', async () => {
    bridge({ 'permissions:set': () => ({ __error: { code: 'INVALID_INPUT', message: 'no' } }) });
    renderUi(<PermissionsScreen />);
    await screen.findAllByTestId('permission-row');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Setting for Clipboard' }),
      'never',
    );
    await waitFor(() => expect(toasts()).toContain('Something went wrong.'));
    expect(screen.getByRole('combobox', { name: 'Setting for Clipboard' })).toHaveValue('ask');
  });

  it('resets only after asking, and is disabled when nothing has changed', async () => {
    renderUi(<PermissionsScreen />);
    await screen.findAllByTestId('permission-row');
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled();
  });

  it('asks before resetting, and resets everything at once', async () => {
    bridge({ 'permissions:list': () => entries({ file_access: 'always_allow' }) });
    renderUi(<PermissionsScreen />);
    await screen.findAllByTestId('permission-row');
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/camera and administrator commands stay off/),
    ).toBeInTheDocument();
    expect(calls('permissions:reset')).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(calls('permissions:reset')).toHaveLength(1));
    await waitFor(() => expect(toasts()).toContain('Permissions reset'));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Setting for File access' })).toHaveValue('ask'),
    );
  });

  it('says the emergency stop works from anywhere when the key is really registered', async () => {
    renderUi(<PermissionsScreen />);
    const card = await screen.findByTestId('stop-card');
    await waitFor(() => expect(within(card).getByText('Escape')).toBeInTheDocument());
    expect(card).toHaveTextContent(/stops everything from anywhere/);
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  it.each([
    ['in_use', /another program is using it/],
    ['invalid', /not a key combination the system accepts/],
    ['unavailable', /system-wide key is not active/],
  ] as const)(
    'says plainly when the key is not registered (%s) — and that STOP still works',
    async (reason, text) => {
      bridge({
        'agent:getSafety': () => ({ emergencyStop: safety({ registered: false, reason }) }),
      });
      renderUi(<PermissionsScreen />);
      const card = await screen.findByTestId('stop-card');
      expect(await within(card).findByRole('alert')).toHaveTextContent(text);
      expect(card).toHaveTextContent(/STOP button/);
    },
  );

  it('asks again which key is in force when the person picks another', async () => {
    renderUi(<PermissionsScreen />);
    await screen.findByTestId('stop-card');
    await waitFor(() => expect(calls('agent:getSafety')).toHaveLength(1));
    act(() => useSafetyStore.getState().bumpSafety());
    await waitFor(() => expect(calls('agent:getSafety')).toHaveLength(2));
  });

  it('the stop-now button stops everything, and the change button opens Settings', async () => {
    renderUi(<PermissionsScreen />);
    await screen.findByTestId('stop-card');
    await userEvent.click(screen.getByRole('button', { name: 'Stop everything now' }));
    await waitFor(() => expect(calls('agent:stop')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Change the key' }));
    expect(useUiStore.getState().route).toBe('settings');
  });

  it('points to the folders and websites, which are set on their own screens', async () => {
    renderUi(<PermissionsScreen />);
    await screen.findAllByTestId('permission-row');
    await userEvent.click(screen.getByRole('button', { name: 'Websites Allaya may open' }));
    expect(useUiStore.getState().route).toBe('browser');
  });

  it('is in Bengali when the app is', async () => {
    renderUi(<PermissionsScreen />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByRole('heading', { name: 'অনুমতি', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'ফাইল অ্যাক্সেস-এর সেটিং' })).toBeInTheDocument();
    expect(await screen.findByText(/যেকোনো জায়গা থেকে সবকিছু থেমে যায়/)).toBeInTheDocument();
  });
});

describe('the Activity screen', () => {
  it('starts with a plain empty state and says how long entries are kept', async () => {
    useUiStore.setState({ route: 'activity' });
    renderUi(<ActivityScreen />);
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
    expect(
      screen.getByText('Kept for 90 days on this computer, then removed.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear activity' })).toBeDisabled();
  });

  it('shows what happened, how risky, how permission was settled and what went wrong', async () => {
    bridge({
      'activity:list': () => ({
        entries: [
          entry(),
          entry({
            id: 'a2',
            tool: 'delete_file',
            action: 'Delete “old.txt”',
            result: 'denied',
            risk: 'HIGH',
            permission: 'denied_by_user',
          }),
          entry({
            id: 'a3',
            result: 'failure',
            error: 'The file was locked',
            permission: 'allowed_by_user',
          }),
          entry({
            id: 'a4',
            actor: 'user',
            tool: undefined,
            action: 'Stopped',
            result: 'cancelled',
            risk: undefined,
            permission: undefined,
          }),
        ],
        hasMore: false,
        retentionDays: 90,
      }),
    });
    renderUi(<ActivityScreen />);
    const rows = await screen.findAllByTestId('activity-entry');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Read the clock')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Done')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Low risk')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('No permission needed')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Refused')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('High risk')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('You said no')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('The file was locked')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('You allowed it')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Stopped', { selector: 'p' })).toBeInTheDocument();
    expect(within(rows[3]!).getByText('You')).toBeInTheDocument();
  });

  it('asks the backend to narrow by result, risk and words (after a short pause for typing)', async () => {
    renderUi(<ActivityScreen />);
    await waitFor(() => expect(calls('activity:list')).toHaveLength(1));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Result' }), 'denied');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Risk' }), 'HIGH');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search activity' }), 'delete');
    await waitFor(() =>
      expect(calls('activity:list').at(-1)).toEqual([
        'activity:list',
        { limit: 50, result: 'denied', risk: 'HIGH', query: 'delete' },
      ]),
    );
    // Typing did not ask once per letter.
    expect(calls('activity:list').filter(([, p]) => (p as { query?: string }).query).length).toBe(
      1,
    );
    expect(await screen.findByText('Nothing matches.')).toBeInTheDocument();
  });

  it('shows older entries on request, without listing any twice', async () => {
    const first = Array.from({ length: 2 }, (_, i) =>
      entry({ id: `n${i}`, timestamp: 9000 - i, action: `New ${i}` }),
    );
    bridge({
      'activity:list': (request: never) => {
        const before = (request as { before?: number }).before;
        return before === undefined
          ? { entries: first, hasMore: true, retentionDays: 90 }
          : {
              entries: [first[1]!, entry({ id: 'old', timestamp: 100, action: 'Old one' })],
              hasMore: false,
              retentionDays: 90,
            };
      },
    });
    renderUi(<ActivityScreen />);
    await screen.findAllByTestId('activity-entry');
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(screen.getAllByTestId('activity-entry')).toHaveLength(3));
    expect(calls('activity:list').at(-1)).toEqual(['activity:list', { limit: 50, before: 8999 }]);
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
    expect(screen.getAllByText('New 1')).toHaveLength(1);
  });

  it('looks again when the backend says something was recorded', async () => {
    renderUi(<ActivityScreen />);
    await waitFor(() => expect(calls('activity:list')).toHaveLength(1));
    act(() => useSafetyStore.getState().bumpActivity());
    await waitFor(() => expect(calls('activity:list')).toHaveLength(2));
  });

  it('clears only after asking, and says so', async () => {
    bridge({ 'activity:list': () => ({ entries: [entry()], hasMore: false, retentionDays: 90 }) });
    renderUi(<ActivityScreen />);
    await screen.findAllByTestId('activity-entry');
    await userEvent.click(screen.getByRole('button', { name: 'Clear activity' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/can't be undone/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls('activity:clear')).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Clear activity' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear activity' }),
    );
    await waitFor(() => expect(calls('activity:clear')).toHaveLength(1));
    await waitFor(() => expect(toasts()).toContain('Activity cleared'));
  });

  it('shows a plain message when it cannot load', async () => {
    bridge({ 'activity:list': () => ({ __error: { code: 'INTERNAL', message: 'x' } }) });
    renderUi(<ActivityScreen />);
    expect(await screen.findByText('Something went wrong.')).toBeInTheDocument();
  });

  it('is in Bengali when the app is', async () => {
    bridge({
      'activity:list': () => ({
        entries: [entry({ result: 'denied', permission: 'denied_by_user' })],
        hasMore: false,
        retentionDays: 90,
      }),
    });
    renderUi(<ActivityScreen />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByRole('heading', { name: 'কার্যকলাপ', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('প্রত্যাখ্যাত', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('আপনি না বলেছেন')).toBeInTheDocument();
  });
});
