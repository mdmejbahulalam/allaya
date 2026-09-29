import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppView, AppsOverview } from '@allaya/validation';
import { AppsScreen } from '../../../apps/desktop/renderer/src/features/apps/apps-screen';
import { useToastStore } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { renderUi } from '../../helpers/render';

const app = (over: Partial<AppView> = {}): AppView => ({
  name: 'Chrome',
  installed: 'yes',
  running: false,
  support: 'full',
  risk: 'LOW',
  ...over,
});
const overview = (apps: AppView[], can = { launch: true, windows: true }): AppsOverview => ({
  apps,
  can,
  platform: 'win32',
});

let invoke: ReturnType<typeof vi.fn>;
type Handlers = Record<string, (p: never) => unknown>;
function bridge(state: AppsOverview, handlers: Handlers = {}) {
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const custom = handlers[channel];
    if (custom) return { ok: true, data: await custom(payload as never) };
    if (channel === 'apps:list') return { ok: true, data: state };
    return { ok: true, data: { ok: true, status: 'success', summary: 'Done' } };
  });
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel);
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);
const cards = () => screen.queryAllByTestId('app-card');

beforeEach(() => {
  bridge(overview([]));
  useUiStore.setState({ route: 'apps' });
});

describe('the Applications screen', () => {
  const sample = overview([
    app({ name: 'Chrome', running: true, lastUsedAt: new Date(2026, 4, 4, 9, 30).getTime() }),
    app({ name: 'Blender', installed: 'no' }),
    app({ name: 'PowerShell', support: 'limited', risk: 'MEDIUM', running: false }),
  ]);

  it('shows each app with installed, running, last used and what Allaya can do with it', async () => {
    bridge(sample);
    renderUi(<AppsScreen />);
    await screen.findAllByTestId('app-card');
    const [chrome, blender, shell] = cards();
    expect(within(chrome!).getByRole('heading', { name: 'Chrome' })).toBeInTheDocument();
    expect(within(chrome!).getByText('Installed')).toBeInTheDocument();
    expect(within(chrome!).getByText('Running')).toBeInTheDocument();
    expect(within(chrome!).getByText('Full control')).toBeInTheDocument();
    expect(within(chrome!).getByText(/Last used by Allaya/)).toBeInTheDocument();
    expect(within(blender!).getByText('Not installed')).toBeInTheDocument();
    expect(within(blender!).getByText('Not used by Allaya yet')).toBeInTheDocument();
    expect(within(shell!).getByText('Open and close only')).toBeInTheDocument();
    expect(within(shell!).getByText(/never types into it/)).toBeInTheDocument();
    expect(within(shell!).getByText(/Opening this one asks you first/)).toBeInTheDocument();
  });

  it('offers only what makes sense: open needs an installed app, close and switch need a running one', async () => {
    bridge(sample);
    renderUi(<AppsScreen />);
    await screen.findAllByTestId('app-card');
    const [chrome, blender] = cards();
    expect(within(chrome!).getByRole('button', { name: 'Open Chrome' })).toBeEnabled();
    expect(within(chrome!).getByRole('button', { name: 'Close Chrome' })).toBeEnabled();
    expect(within(chrome!).getByRole('button', { name: 'Switch to Chrome' })).toBeEnabled();
    expect(within(blender!).getByRole('button', { name: 'Open Blender' })).toBeDisabled();
    expect(within(blender!).getByRole('button', { name: 'Close Blender' })).toBeDisabled();
  });

  it('acts through the backend, says what happened, and looks again', async () => {
    bridge(sample, {
      'apps:open': () => ({ ok: true, status: 'success', summary: 'Open Chrome' }),
      'apps:close': () => ({
        ok: false,
        status: 'failed',
        summary: 'Close Chrome',
        message: 'Chrome asked to save first',
      }),
    });
    renderUi(<AppsScreen />);
    await screen.findAllByTestId('app-card');
    const chrome = cards()[0]!;
    await userEvent.click(within(chrome).getByRole('button', { name: 'Open Chrome' }));
    await waitFor(() => expect(calls('apps:open')).toEqual([['apps:open', { name: 'Chrome' }]]));
    await waitFor(() => expect(toasts()).toContain('Open Chrome'));
    await userEvent.click(within(chrome).getByRole('button', { name: 'Close Chrome' }));
    await waitFor(() => expect(toasts()).toContain('Chrome asked to save first'));
    await userEvent.click(within(chrome).getByRole('button', { name: 'Switch to Chrome' }));
    await waitFor(() => expect(calls('apps:focus')).toHaveLength(1));
    // After each action the list is asked for again.
    await waitFor(() => expect(calls('apps:list').length).toBeGreaterThanOrEqual(4));
  });

  it('searches by name and can show only what is installed', async () => {
    bridge(sample);
    renderUi(<AppsScreen />);
    await screen.findAllByTestId('app-card');
    await userEvent.click(screen.getByRole('switch', { name: 'Show only installed apps' }));
    expect(cards()).toHaveLength(2);
    await userEvent.click(screen.getByRole('switch', { name: 'Show only installed apps' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search apps' }), 'power');
    expect(cards()).toHaveLength(1);
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByText('No apps match.')).toBeInTheDocument();
  });

  it('where this computer cannot control apps it says so, shows what it knows, and disables the buttons', async () => {
    bridge(
      overview([app({ installed: 'unknown', running: null, support: 'none' })], {
        launch: false,
        windows: false,
      }),
    );
    renderUi(<AppsScreen />);
    const card = (await screen.findAllByTestId('app-card'))[0]!;
    expect(screen.getByRole('status')).toHaveTextContent(/cannot open or control apps/);
    expect(within(card).getByText('Install status unknown')).toBeInTheDocument();
    expect(within(card).getByText('Running status unknown')).toBeInTheDocument();
    expect(within(card).getByText('Not available here')).toBeInTheDocument();
    for (const name of ['Open Chrome', 'Close Chrome', 'Switch to Chrome']) {
      expect(within(card).getByRole('button', { name })).toBeDisabled();
    }
  });

  it('refreshes on demand and when the window comes to the front', async () => {
    bridge(sample);
    renderUi(<AppsScreen />);
    await screen.findAllByTestId('app-card');
    const before = calls('apps:list').length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls('apps:list').length).toBe(before + 1));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(calls('apps:list').length).toBe(before + 2));
  });

  it('links to the permissions for apps', async () => {
    bridge(sample);
    renderUi(<AppsScreen />);
    await screen.findAllByTestId('app-card');
    await userEvent.click(within(cards()[0]!).getByRole('button', { name: 'Manage permissions' }));
    expect(useUiStore.getState().route).toBe('permissions');
  });

  it('says plainly when it cannot load, and is in Bengali when the app is', async () => {
    invoke = vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', message: 'x' } }));
    (window as unknown as { allaya: unknown }).allaya = {
      invoke,
      subscribe: () => () => undefined,
    };
    const first = renderUi(<AppsScreen />);
    expect(await screen.findByText('Something went wrong.')).toBeInTheDocument();
    first.unmount();
    bridge(sample);
    renderUi(<AppsScreen />, { settings: { 'language.ui': 'bn' } });
    expect(
      await screen.findByRole('heading', { name: 'অ্যাপ্লিকেশন', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('ইনস্টল করা আছে').length).toBeGreaterThan(0);
  });
});
