import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatusEvent, UpdateStatus } from '@allaya/validation';
import { FloatingAssistant } from '../../../apps/desktop/renderer/src/features/floating/floating-assistant';
import { UpdatesCard } from '../../../apps/desktop/renderer/src/features/help/updates-card';
import { useBackendSync } from '@renderer/app/use-backend-sync';
import { useAppInfoStore } from '@renderer/stores/app-info';
import { useTasksStore } from '@renderer/stores/tasks';
import { useToastStore } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { useUpdatesStore } from '@renderer/stores/updates';
import { renderUi } from '../../helpers/render';

let invoke: ReturnType<typeof vi.fn>;
let listeners: Map<string, Array<(payload: unknown) => void>>;
type Handlers = Record<string, (p: never) => unknown>;

function bridge(handlers: Handlers = {}) {
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
    switch (channel) {
      case 'updates:getStatus':
        return { ok: true, data: { state: 'idle' } };
      case 'agent:getStatus':
        return { ok: true, data: { status: 'ready', activeRuns: 0 } };
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
const emit = (channel: string, payload: unknown = {}) =>
  act(() => listeners.get(channel)?.forEach((listener) => listener(payload)));
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel);
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);

beforeEach(() => {
  bridge();
  useUpdatesStore.setState({ status: null });
  useAppInfoStore.setState({ version: '1.2.3' } as never);
  useUiStore.setState({ route: 'help' });
});

describe('the Updates card', () => {
  const show = async (status: UpdateStatus) => {
    bridge({ 'updates:getStatus': () => status });
    renderUi(<UpdatesCard />);
    return screen.findByTestId('updates-card');
  };

  it('says which version this is, and offers to look', async () => {
    const card = await show({ state: 'idle' });
    expect(within(card).getByText('You have version 1.2.3.')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Check for updates' })).toBeEnabled();
    expect(within(card).getByText(/checked against the publisher's list/)).toBeInTheDocument();
  });

  it('a build with no update feed says so and has nothing to press', async () => {
    const card = await show({ state: 'unsupported' });
    await waitFor(() =>
      expect(
        within(card).getByText('Updates are not available in this build.'),
      ).toBeInTheDocument(),
    );
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it.each([
    [{ state: 'up_to_date', checkedAt: 1 }, 'You have the latest version.'],
    [{ state: 'available', version: '2.0.0' }, 'Version 2.0.0 is available.'],
    [{ state: 'ready', version: '2.0.0' }, /Version 2.0.0 is ready/],
    [{ state: 'error', reason: 'network' }, 'Could not check for updates. Try again later.'],
    [{ state: 'checking' }, 'Looking for updates…'],
  ] as const)('shows %j in words', async (status, text) => {
    const card = await show(status);
    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent(text));
  });

  it('shows the progress of a download', async () => {
    const card = await show({ state: 'downloading', version: '2.0.0', percent: 40 });
    await waitFor(() =>
      expect(within(card).getByRole('status')).toHaveTextContent('Downloading version 2.0.0… 40%'),
    );
    expect(within(card).getByRole('progressbar')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  });

  it('asks the backend to look, to download, and — only when pressed — to install', async () => {
    bridge({
      'updates:getStatus': () => ({ state: 'idle' }),
      'updates:check': () => ({ state: 'available', version: '2.0.0' }),
      'updates:download': () => ({ state: 'ready', version: '2.0.0' }),
    });
    renderUi(<UpdatesCard />);
    const card = await screen.findByTestId('updates-card');
    await userEvent.click(within(card).getByRole('button', { name: 'Check for updates' }));
    await userEvent.click(await within(card).findByRole('button', { name: 'Download' }));
    expect(calls('updates:download')).toHaveLength(1);
    const install = await within(card).findByRole('button', { name: 'Restart and install' });
    expect(calls('updates:install')).toEqual([]);
    await userEvent.click(install);
    await waitFor(() => expect(calls('updates:install')).toHaveLength(1));
  });

  it('says plainly that Allaya is busy when an install is refused for that', async () => {
    bridge({
      'updates:getStatus': () => ({ state: 'ready', version: '2.0.0' }),
      'updates:install': () => ({
        __error: { code: 'CONFLICT', message: 'busy', details: { reason: 'busy' } },
      }),
    });
    renderUi(<UpdatesCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Restart and install' }));
    await waitFor(() =>
      expect(toasts()).toEqual([expect.stringMatching(/Allaya is working right now/)]),
    );
  });

  it('follows changes announced by the backend', async () => {
    renderUi(<UpdatesCard />);
    const card = await screen.findByTestId('updates-card');
    function Probe() {
      useBackendSync();
      return null;
    }
    renderUi(<Probe />);
    emit('updates:changed', { state: 'available', version: '3.0.0' });
    await waitFor(() =>
      expect(within(card).getByRole('status')).toHaveTextContent('Version 3.0.0 is available.'),
    );
  });

  it('is in Bengali when the app is', async () => {
    bridge({ 'updates:getStatus': () => ({ state: 'up_to_date', checkedAt: 1 }) });
    renderUi(<UpdatesCard />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByRole('heading', { name: 'আপডেট' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('আপনার কাছে সর্বশেষ ভার্সন আছে।'),
    );
  });
});

describe('the floating assistant', () => {
  const agent = (over: Partial<AgentStatusEvent>): AgentStatusEvent => ({
    status: 'ready',
    activeRuns: 0,
    ...over,
  });

  it('says Ready, then Working while something runs, then Needs you when it is waiting', async () => {
    renderUi(<FloatingAssistant />);
    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('Ready'));
    emit('agent:status', agent({ status: 'working', activeRuns: 1 }));
    await waitFor(() => expect(status).toHaveTextContent('Working…'));
    emit('agent:status', agent({ status: 'paused', activeRuns: 1 }));
    await waitFor(() => expect(status).toHaveTextContent('Needs you'));
    emit('agent:status', agent({}));
    await waitFor(() => expect(status).toHaveTextContent('Ready'));
  });

  it('STOP stops everything through the main process; the label opens the app', async () => {
    renderUi(<FloatingAssistant />);
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: 'STOP' }));
    expect(calls('desktop:stopEverything')).toHaveLength(1);
    await userEvent.click(screen.getByTitle('Open Allaya'));
    expect(calls('desktop:showApp')).toHaveLength(1);
  });

  it('is in Bengali when the app is', async () => {
    renderUi(<FloatingAssistant />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByRole('group', { name: 'Allaya সহকারী' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('প্রস্তুত'));
  });
});

describe('going to a screen when a notification or the tray asks', () => {
  function Probe() {
    useBackendSync();
    return null;
  }
  it('shows the task that a notification was about', () => {
    useTasksStore.setState({ byId: {}, loaded: true, selectedId: null });
    useUiStore.setState({ route: 'home' });
    renderUi(<Probe />);
    emit('app:navigate', { route: 'tasks', taskId: 'task_7' });
    expect(useUiStore.getState().route).toBe('tasks');
    expect(useTasksStore.getState().selectedId).toBe('task_7');
  });
  it('shows a screen without changing the selected task when none is named', () => {
    useTasksStore.setState({ byId: {}, loaded: true, selectedId: 'keep' });
    renderUi(<Probe />);
    emit('app:navigate', { route: 'home' });
    expect(useUiStore.getState().route).toBe('home');
    expect(useTasksStore.getState().selectedId).toBe('keep');
  });
});
