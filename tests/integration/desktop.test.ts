import { afterEach, describe, expect, it } from 'vitest';
import type { ShellStatus, UpdateStatus } from '@allaya/validation';
import { createTestBackend, type TestBackend } from '../helpers/backend';

const backends: TestBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
});
type Ok<T> = { ok: true; data: T };
type Failed = { ok: false; error: { code: string; details?: Record<string, unknown> } };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const failure = (r: unknown) => (r as Failed).error;

const boot = (options: Parameters<typeof createTestBackend>[0] = {}) => {
  const backend = createTestBackend(options);
  backends.push(backend);
  return backend;
};

describe('the desktop shell, as the window sees it', () => {
  it('says plainly that nothing is available when no shell has been set up (as in tests)', async () => {
    const backend = boot();
    expect(data<ShellStatus>(await backend.call('desktop:getStatus'))).toEqual({
      trayAvailable: false,
      launchAtLoginSupported: false,
      showAppKey: { accelerator: 'Ctrl+Alt+Space', registered: false, reason: 'unavailable' },
    });
  });

  it('shows the key the person chose for "show Allaya"', async () => {
    const backend = boot();
    await backend.call('settings:set', { key: 'shortcuts.showApp', value: 'Ctrl+Alt+J' });
    expect(data<ShellStatus>(await backend.call('desktop:getStatus')).showAppKey.accelerator).toBe(
      'Ctrl+Alt+J',
    );
  });

  it('reports what the real shell tells it', async () => {
    const backend = boot({
      shellStatus: () => ({
        trayAvailable: true,
        launchAtLoginSupported: true,
        showAppKey: { accelerator: 'Ctrl+Alt+Space', registered: true },
      }),
    });
    expect(data<ShellStatus>(await backend.call('desktop:getStatus'))).toMatchObject({
      trayAvailable: true,
      launchAtLoginSupported: true,
    });
  });

  it('keeps its settings validated: notifications, updates, and the show key', async () => {
    const backend = boot();
    for (const [key, value] of [
      ['notifications.native', 'yes'],
      ['updates.auto', 1],
      ['shortcuts.showApp', 'x'.repeat(65)],
      ['shortcuts.showApp', 42],
    ] as const) {
      const result = (await backend.call('settings:set', { key, value })) as { ok: boolean };
      expect(result.ok, `${key}=${String(value)}`).toBe(false);
    }
    for (const [key, value] of [
      ['notifications.native', false],
      ['updates.auto', false],
      ['general.minimizeToTray', false],
    ] as const) {
      expect(((await backend.call('settings:set', { key, value })) as { ok: boolean }).ok).toBe(
        true,
      );
    }
  });
});

describe('stopping from outside the main window', () => {
  it('stops every run and tells the main window who did it (so it can silence the microphone)', async () => {
    const backend = boot();
    const first = backend.container.runs.start('run-a', 'chat');
    const second = backend.container.runs.start('run-b', 'task');
    expect(data<{ cancelled: number }>(await backend.call('desktop:stopEverything'))).toEqual({
      cancelled: 2,
    });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(backend.eventsOf('agent:stopped')).toEqual([{ cancelled: 2, via: 'floating' }]);
  });

  it('the tray and the system-wide key use the same stop, and say which they were', () => {
    const backend = boot();
    backend.container.runs.start('run-a', 'chat');
    expect(backend.container.stopEverything('tray')).toBe(1);
    backend.container.runs.finish('run-a');
    expect(backend.container.stopEverything('shortcut')).toBe(0);
    expect(backend.eventsOf('agent:stopped')).toEqual([
      { cancelled: 1, via: 'tray' },
      { cancelled: 0, via: 'shortcut' },
    ]);
  });

  it('a stop pauses every schedule, as the emergency stop always does', async () => {
    const backend = boot();
    await backend.call('automations:create', {
      name: 'A',
      instruction: 'Do it',
      trigger: { kind: 'interval', everyMinutes: 5 },
    });
    await backend.call('desktop:stopEverything');
    expect(backend.container.settings.get('automations.paused')).toBe(true);
  });

  it('showing the app asks the running shell to do it, and does nothing where there is none', async () => {
    let shown = 0;
    const withShell = boot({ showApp: () => (shown += 1) });
    expect(data(await withShell.call('desktop:showApp'))).toEqual({ ok: true });
    expect(shown).toBe(1);
    const bare = boot();
    expect(data(await bare.call('desktop:showApp'))).toEqual({ ok: true });
    expect(shown).toBe(1);
  });
});

describe('updates', () => {
  const fakePort = () => {
    const state = { installs: 0, downloads: 0 };
    return {
      state,
      port: {
        check: () => Promise.resolve({ version: '9.9.9' }),
        download: (onProgress: (p: number) => void) => {
          state.downloads += 1;
          onProgress(50);
          return Promise.resolve();
        },
        install: () => {
          state.installs += 1;
        },
      },
    };
  };

  it('reports "unsupported" where there is no feed, and installing is refused', async () => {
    const backend = boot();
    expect(data<UpdateStatus>(await backend.call('updates:getStatus'))).toEqual({
      state: 'unsupported',
    });
    expect(data<UpdateStatus>(await backend.call('updates:check'))).toEqual({
      state: 'unsupported',
    });
    expect(failure(await backend.call('updates:install')).code).toBe('CONFLICT');
  });

  it('finds an update, downloads it (as the person allowed), announces each step, and waits to be told to install', async () => {
    const { port, state } = fakePort();
    const backend = boot({ updates: { port } });
    const status = data<UpdateStatus>(await backend.call('updates:check'));
    expect(status).toEqual({ state: 'ready', version: '9.9.9' });
    expect(state.downloads).toBe(1);
    expect(state.installs).toBe(0);
    const announced = backend.eventsOf('updates:changed').map((s) => (s as UpdateStatus).state);
    expect(announced).toEqual(['checking', 'downloading', 'downloading', 'ready']);
    expect(data<UpdateStatus>(await backend.call('updates:getStatus'))).toEqual(status);
  });

  it('with "download automatically" off, only offers it until the person asks', async () => {
    const { port, state } = fakePort();
    const backend = boot({ updates: { port } });
    await backend.call('settings:set', { key: 'updates.auto', value: false });
    expect(data<UpdateStatus>(await backend.call('updates:check'))).toEqual({
      state: 'available',
      version: '9.9.9',
    });
    expect(state.downloads).toBe(0);
    expect(data<UpdateStatus>(await backend.call('updates:download'))).toEqual({
      state: 'ready',
      version: '9.9.9',
    });
  });

  it('will not restart Allaya into an update while it is working, and does once it is idle', async () => {
    const { port, state } = fakePort();
    const backend = boot({ updates: { port } });
    await backend.call('updates:check');
    const run = backend.container.runs.start('busy-run', 'chat');
    const refused = failure(await backend.call('updates:install'));
    expect(refused.code).toBe('CONFLICT');
    expect(refused.details).toMatchObject({ reason: 'busy' });
    expect(state.installs).toBe(0);
    backend.container.runs.finish('busy-run');
    void run;
    expect(data(await backend.call('updates:install'))).toEqual({ ok: true });
    expect(state.installs).toBe(1);
  });
});
