import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Diagnostics } from '@allaya/validation';
import { SettingsScreen } from '../../../apps/desktop/renderer/src/features/settings/settings-screen';
import { useToastStore } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { renderUi } from '../../helpers/render';

const stop = { registered: true } as never;
const report = (over: Partial<Diagnostics> = {}): Diagnostics => ({
  generatedAt: 1,
  app: {
    name: 'Allaya',
    version: '1.2.3',
    electron: '41.0.0',
    chrome: '1',
    node: '1',
    platform: 'win32',
    osVersion: '10.0.22631',
    arch: 'x64',
    packaged: true,
    environment: 'production',
  },
  database: {
    tone: 'ok',
    ok: true,
    migrations: 6,
    tables: 20,
    journalMode: 'wal',
    foreignKeys: true,
  },
  providers: { tone: 'attention', connected: 0, total: 3, items: [] },
  voice: {
    tone: 'ok',
    enabled: true,
    speechEngine: 'system',
    inputLanguage: 'auto',
    cloudSpeechReady: false,
  },
  computer: { tone: 'ok', adapter: 'windows', platform: 'win32', capabilities: {} },
  browser: { tone: 'off', available: false, engine: null, running: false },
  automations: { tone: 'ok', total: 4, enabled: 2, paused: false },
  memory: { tone: 'ok', enabled: true, count: 7 },
  permissions: { tone: 'ok', changed: [{ subject: 'files', mode: 'allow' }] },
  shell: {
    tone: 'ok',
    trayAvailable: true,
    launchAtLoginSupported: true,
    emergencyStop: stop,
    showAppKey: stop,
  },
  updates: { tone: 'ok', state: 'idle' },
  logs: {},
  ...over,
});

let invoke: ReturnType<typeof vi.fn>;
function bridge(data: Diagnostics | 'fail', saved = true) {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'diagnostics:get')
      return data === 'fail'
        ? { ok: false, error: { code: 'INTERNAL', message: 'x' } }
        : { ok: true, data };
    if (channel === 'diagnostics:export') return { ok: true, data: { saved } };
    if (channel === 'updates:getStatus') return { ok: true, data: { state: 'idle' } };
    if (channel === 'desktop:getStatus')
      return {
        ok: true,
        data: {
          trayAvailable: true,
          launchAtLoginSupported: true,
          emergencyStop: stop,
          showAppKey: stop,
        },
      };
    return { ok: true, data: {} };
  });
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}

const open = async (name: string) => {
  renderUi(<SettingsScreen />);
  await userEvent.click(screen.getByRole('button', { name }));
};

beforeEach(() => {
  bridge(report());
  useUiStore.setState({ route: 'settings' });
  useToastStore.setState({ toasts: [] });
});

describe('Settings → Advanced → Diagnostics', () => {
  it('shows versions and the state of each part', async () => {
    await open('Advanced');
    const box = await screen.findByRole('status', { name: 'Diagnostics' });
    expect(within(box).getByText('1.2.3')).toBeInTheDocument();
    expect(within(box).getByText('41.0.0')).toBeInTheDocument();
    expect(within(box).getByText(/win32 10\.0\.22631/)).toBeInTheDocument();
    expect(within(box).getByText('0 of 3 connected')).toBeInTheDocument();
    expect(within(box).getAllByText('Needs a look')).toHaveLength(1);
    expect(within(box).getByText('1 changed from the default')).toBeInTheDocument();
  });

  it('refreshes on request', async () => {
    await open('Advanced');
    await screen.findByRole('status', { name: 'Diagnostics' });
    const before = invoke.mock.calls.filter(([c]) => c === 'diagnostics:get').length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === 'diagnostics:get').length).toBe(before + 1),
    );
  });

  it('exports on request and says so — and says nothing if the person cancelled', async () => {
    await open('Advanced');
    await userEvent.click(await screen.findByRole('button', { name: 'Export diagnostics' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain('Diagnostics saved.'),
    );
    useToastStore.setState({ toasts: [] });
    bridge(report(), false);
    await userEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('diagnostics:export'));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('says so when the report cannot be read', async () => {
    bridge('fail');
    await open('Advanced');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read diagnostics.');
  });
});

describe('the other Settings sections', () => {
  it('point to the screen that holds the settings', async () => {
    await open('Computer Control');
    await userEvent.click(screen.getByRole('button', { name: /Open Computer Control/ }));
    expect(useUiStore.getState().route).toBe('computer');
  });

  it('Updates shows the updater and the automatic-update switch', async () => {
    await open('Updates');
    expect(await screen.findByTestId('updates-card')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /automatically/ })).toBeInTheDocument();
  });
});
