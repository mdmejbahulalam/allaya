import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_CATALOG,
  CompositeAdapter,
  ComputerEngine,
  MemoryAdapter,
  type WindowInfo,
} from '@allaya/computer';
import type { AppOutcome, AppsOverview } from '@allaya/validation';
import { createTestBackend, type TestBackend } from '../helpers/backend';

let backend: TestBackend | undefined;
afterEach(() => backend?.dispose());

type Ok<T> = { ok: true; data: T };
type Failed = { ok: false; error: { code: string } };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const failure = (r: unknown) => (r as Failed).error;

const win = (processName: string, id = processName): WindowInfo => ({
  id,
  title: processName,
  processName,
  pid: 10,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: false,
  minimized: false,
});

function boot(adapter: MemoryAdapter | undefined) {
  backend = createTestBackend(
    adapter
      ? {
          computer: {
            engine: new ComputerEngine({
              adapter: new CompositeAdapter(adapter, undefined),
              ownPid: 1,
            }),
          },
        }
      : {},
  );
  return backend;
}
const list = async (b: TestBackend) => data<AppsOverview>(await b.call('apps:list'));
const byName = (overview: AppsOverview, name: string) =>
  overview.apps.find((a) => a.name === name)!;

describe('the Applications screen data', () => {
  it('lists every catalog app, with what is true of each on this computer', async () => {
    const b = boot(
      new MemoryAdapter({
        installed: ['Chrome', 'Notepad', 'PowerShell'],
        windows: [win('chrome'), win('notepad')],
      }),
    );
    const overview = await list(b);
    expect(overview.apps.map((a) => a.name)).toEqual(APP_CATALOG.map((a) => a.name));
    expect(overview.can).toEqual({ launch: true, windows: true });
    expect(byName(overview, 'Chrome')).toMatchObject({
      installed: 'yes',
      running: true,
      support: 'full',
    });
    expect(byName(overview, 'Notepad')).toMatchObject({ installed: 'yes', running: true });
    expect(byName(overview, 'Blender')).toMatchObject({ installed: 'no', running: false });
    // A shell is opened and closed, never given typed input — and opening it is riskier.
    expect(byName(overview, 'PowerShell')).toMatchObject({
      installed: 'yes',
      running: false,
      support: 'limited',
      risk: 'MEDIUM',
    });
    expect(byName(overview, 'Chrome').lastUsedAt).toBeUndefined();
  });

  it('says "unknown" and "none" where this computer cannot tell or cannot control apps (not a guess)', async () => {
    const b = boot(undefined);
    const overview = await list(b);
    expect(overview.can).toEqual({ launch: false, windows: false });
    for (const app of overview.apps) {
      expect(app).toMatchObject({ installed: 'unknown', running: null, support: 'none' });
    }
  });

  it('what the adapter can do decides the support level', async () => {
    const b = boot(new MemoryAdapter({ capabilities: { uiAutomation: false, mouse: false } }));
    expect(byName(await list(b), 'Chrome').support).toBe('basic');
  });

  it('opening goes through the same tools as the AI: it needs the person’s permission setting, and is recorded', async () => {
    const adapter = new MemoryAdapter({ installed: ['Notepad'] });
    const b = boot(adapter);
    await b.call('permissions:set', { subject: 'application_launch', mode: 'always_allow' });
    const outcome = data<AppOutcome>(await b.call('apps:open', { name: 'Notepad' }));
    expect(outcome).toMatchObject({ ok: true, status: 'success' });
    expect(adapter.launched).toEqual(['notepad']);
    const overview = await list(b);
    expect(byName(overview, 'Notepad')).toMatchObject({ running: true });
    expect(byName(overview, 'Notepad').lastUsedAt).toBeGreaterThan(0);
    expect(byName(overview, 'Chrome').lastUsedAt).toBeUndefined();
  });

  it('closing and switching to an app work through the tools; switching to one that is not open says so', async () => {
    const adapter = new MemoryAdapter({ windows: [win('notepad', '7')] });
    const b = boot(adapter);
    await b.call('permissions:set', { subject: 'application_launch', mode: 'always_allow' });
    await b.call('permissions:set', { subject: 'computer_control', mode: 'always_allow' });
    expect(data<AppOutcome>(await b.call('apps:focus', { name: 'Notepad' }))).toMatchObject({
      ok: true,
    });
    expect(adapter.focusedIds).toEqual(['7']);
    const notOpen = data<AppOutcome>(await b.call('apps:focus', { name: 'Blender' }));
    expect(notOpen).toMatchObject({ ok: false, message: 'Blender is not open' });
    expect(adapter.focusedIds).toEqual(['7']);
    expect(data<AppOutcome>(await b.call('apps:close', { name: 'Notepad' }))).toMatchObject({
      ok: true,
    });
    expect(adapter.closed).toEqual(['7']);
  });

  it('a permission set to "never" blocks the buttons, exactly as it blocks the AI', async () => {
    const adapter = new MemoryAdapter({});
    const b = boot(adapter);
    await b.call('permissions:set', { subject: 'application_launch', mode: 'never' });
    const outcome = data<AppOutcome>(await b.call('apps:open', { name: 'Notepad' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('denied');
    expect(adapter.launched).toEqual([]);
  });

  it('opening a riskier app (a shell) asks first under the default setting; a harmless one does not need to', async () => {
    const adapter = new MemoryAdapter({});
    const b = boot(adapter);
    const pending = b.call('apps:open', { name: 'PowerShell' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const asked = b.container.tools.pendingConfirmations();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: 'open_app', risk: 'MEDIUM' });
    expect(adapter.launched).toEqual([]);
    await b.call('tools:respondConfirmation', { id: asked[0]!.id, decision: 'rejected' });
    expect(data<AppOutcome>(await pending).status).toBe('rejected');
    expect(adapter.launched).toEqual([]);
    // Harmless apps (LOW risk) are opened without a question, as when the AI opens them.
    expect(data<AppOutcome>(await b.call('apps:open', { name: 'Notepad' })).ok).toBe(true);
    expect(adapter.launched).toEqual(['notepad']);
  });

  it('refuses anything that is not a catalog app — a path, a command, a shell string — before it goes anywhere', async () => {
    const adapter = new MemoryAdapter({});
    const b = boot(adapter);
    await b.call('permissions:set', { subject: 'application_launch', mode: 'always_allow' });
    for (const name of [
      'C:\\Windows\\System32\\cmd.exe',
      'notepad; calc',
      '../../evil',
      'rm -rf /',
      '__proto__',
      'x'.repeat(61),
      '',
    ]) {
      for (const channel of ['apps:open', 'apps:close', 'apps:focus'] as const) {
        const result = await b.call(channel, { name });
        expect((result as { ok: boolean }).ok, `${channel} ${name}`).toBe(false);
      }
    }
    expect(adapter.launched).toEqual([]);
    expect(adapter.closed).toEqual([]);
    expect(failure(await b.call('apps:open', { name: 'Not An App' })).code).toBe('NOT_FOUND');
    expect(failure(await b.call('apps:open', { name: 'Notepad', extra: 1 })).code).toBe(
      'INVALID_IPC_PAYLOAD',
    );
  });
});
