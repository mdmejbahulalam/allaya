import { describe, expect, it } from 'vitest';
import { MemorySink, StructuredLogger } from '@allaya/shared';
import {
  ConfirmationBroker,
  DEFAULT_PERMISSION_MODES,
  ToolExecutor,
  ToolRegistry,
  type ExecutionResult,
  type ToolAuditSink,
} from '@allaya/tools';
import {
  CompositeAdapter,
  ComputerEngine,
  MemoryAdapter,
  TINY_PNG,
  createComputerTools,
  type ScreenshotStore,
  type WindowInfo,
} from '@allaya/computer';

const OWN_PID = 4242;
const win = (over: Partial<WindowInfo> & { processName: string }): WindowInfo => ({
  id: over.id ?? over.processName,
  title: over.title ?? over.processName,
  pid: 1,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: false,
  minimized: false,
  ...over,
});

class MemoryStore implements ScreenshotStore {
  files = new Map<string, Uint8Array>();
  corrupt = false;
  missing = false;
  async save(bytes: Uint8Array) {
    const path = `/shots/shot-${this.files.size + 1}.png`;
    this.files.set(path, this.corrupt ? new Uint8Array([1, 2, 3]) : bytes);
    return { path, bytes: bytes.byteLength };
  }
  async inspect(path: string) {
    const file = this.files.get(path);
    return this.missing || !file ? undefined : { bytes: file.byteLength, head: file.slice(0, 8) };
  }
}

class Audit implements ToolAuditSink {
  begun: Array<Parameters<ToolAuditSink['begin']>[0]> = [];
  finished: ExecutionResult[] = [];
  begin(e: Parameters<ToolAuditSink['begin']>[0]) {
    this.begun.push(e);
  }
  finish(r: ExecutionResult) {
    this.finished.push(r);
  }
}

function setup(
  over: {
    adapter?: MemoryAdapter;
    host?: boolean;
    modes?: Record<string, 'ask' | 'always_allow' | 'never'>;
  } = {},
) {
  const adapter =
    over.adapter ??
    new MemoryAdapter({ windows: [win({ processName: 'notepad', id: '1', focused: true })] });
  const engine = new ComputerEngine({ adapter, ownPid: OWN_PID, waitMs: 120, pollMs: 10 });
  const store = new MemoryStore();
  const registry = new ToolRegistry();
  for (const tool of createComputerTools(engine, store)) registry.register(tool);
  const broker = new ConfirmationBroker({ timeoutMs: 5000 });
  const audit = new Audit();
  const modes = over.modes ?? {};
  const executor = new ToolExecutor({
    registry,
    modeFor: (s) => modes[s] ?? DEFAULT_PERMISSION_MODES[s],
    broker,
    audit,
    logger: new StructuredLogger([new MemorySink()], 't', 'DEBUG'),
  });
  const run = (name: string, args: unknown) =>
    executor.execute(
      { id: `call_${name}_${audit.begun.length}`, name, arguments: args },
      { signal: new AbortController().signal, language: 'en' },
    );
  /** Runs a tool that needs confirmation and approves it. */
  const runApproved = async (name: string, args: unknown) => {
    const pending = run(name, args);
    await new Promise((r) => setTimeout(r, 0));
    broker.respond(broker.pending()[0]!.id, 'approved', 'ui');
    return pending;
  };
  return { adapter, engine, store, registry, broker, audit, run, runApproved };
}

describe('which tools are offered', () => {
  const names = (engine: ComputerEngine) =>
    createComputerTools(engine, new MemoryStore())
      .map((t) => t.name)
      .sort();

  it('a full desktop gets every tool', () => {
    expect(names(new ComputerEngine({ adapter: new MemoryAdapter() }))).toEqual([
      'click_at',
      'click_element',
      'close_app',
      'focus_window',
      'list_windows',
      'open_app',
      'press_keys',
      'read_clipboard',
      'scroll',
      'take_screenshot',
      'type_text',
      'write_clipboard',
    ]);
  });

  it('a host-only machine (no input adapter) is offered only screenshot and clipboard tools — never "type_text"', () => {
    const engine = new ComputerEngine({
      adapter: new CompositeAdapter(undefined, new MemoryAdapter(), 'linux'),
    });
    expect(names(engine)).toEqual(['read_clipboard', 'take_screenshot', 'write_clipboard']);
  });

  it('offers no screenshot tool without somewhere to save it', () => {
    const engine = new ComputerEngine({ adapter: new MemoryAdapter() });
    expect(createComputerTools(engine).map((t) => t.name)).not.toContain('take_screenshot');
  });

  it('every tool description warns the model about its limits, and names are valid', () => {
    const registry = new ToolRegistry();
    for (const tool of createComputerTools(
      new ComputerEngine({ adapter: new MemoryAdapter() }),
      new MemoryStore(),
    ))
      registry.register(tool);
    for (const spec of registry.toModelTools())
      expect(spec.description.length, spec.name).toBeGreaterThan(40);
  });
});

describe('open_app / close_app', () => {
  it('opens a known app without asking, and verifies its window is on screen', async () => {
    const r = setup({ adapter: new MemoryAdapter() });
    const result = await r.run('open_app', { app: 'Chrome' });
    expect(result).toMatchObject({
      status: 'success',
      ok: true,
      verification: 'verified',
      risk: 'LOW',
      permission: 'allowed',
      output: { app: 'Chrome', windowAppeared: true },
    });
    expect(result.evidence).toMatch(/Chrome window is open/);
    expect(r.adapter.launched).toEqual(['chrome']);
  });

  it('shells are MEDIUM risk and therefore ask first', async () => {
    const r = setup({ adapter: new MemoryAdapter() });
    const pending = r.run('open_app', { app: 'PowerShell' });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.broker.pending()[0]).toMatchObject({ risk: 'MEDIUM', summary: 'Open PowerShell' });
    expect(r.adapter.launched).toEqual([]);
    r.broker.cancelAll();
    await pending;
  });

  it('an unknown app is a clear failure, and nothing is launched', async () => {
    const r = setup({ adapter: new MemoryAdapter() });
    const result = await r.run('open_app', { app: 'C:\\Windows\\System32\\cmd.exe' });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    expect(r.adapter.launched).toEqual([]);
  });

  it('if no window appears, the action is reported as failed rather than done', async () => {
    const r = setup({ adapter: new MemoryAdapter({ windowsAppearOnLaunch: false }) });
    const result = await r.run('open_app', { app: 'Notepad' });
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      verification: 'failed',
      error: { code: 'VERIFICATION_FAILED' },
    });
    expect(result.evidence).toMatch(/No Notepad window appeared/);
  });

  it('closes an app and verifies it is gone — asks first because closing can lose work', async () => {
    const r = setup({
      adapter: new MemoryAdapter({ windows: [win({ processName: 'notepad', id: '1' })] }),
    });
    const result = await r.runApproved('close_app', { app: 'Notepad' });
    expect(result).toMatchObject({
      status: 'success',
      verification: 'verified',
      risk: 'MEDIUM',
      permission: 'allowed_by_user',
    });
  });

  it('a window that refuses to close (unsaved changes) is not reported as closed', async () => {
    const r = setup({
      adapter: new MemoryAdapter({
        windows: [win({ processName: 'notepad', id: '1' })],
        windowsCloseOnRequest: false,
      }),
    });
    const result = await r.runApproved('close_app', { app: 'Notepad' });
    expect(result).toMatchObject({
      ok: false,
      verification: 'failed',
      error: { code: 'VERIFICATION_FAILED' },
    });
    expect(result.evidence).toMatch(/still has 1 window/);
  });

  it('rejects arguments the schema does not allow', async () => {
    const r = setup({ adapter: new MemoryAdapter() });
    expect((await r.run('open_app', { app: 'x'.repeat(61) })).status).toBe('invalid');
    expect((await r.run('open_app', { app: 'Chrome', args: ['--evil'] })).status).toBe('invalid'); // strict: no extra fields
    expect((await r.run('open_app', {})).status).toBe('invalid');
    expect(r.adapter.launched).toEqual([]);
  });
});

describe('windows', () => {
  it('lists windows without asking, hiding nothing about elevation', async () => {
    const r = setup({
      adapter: new MemoryAdapter({
        windows: [
          win({ processName: 'notepad', id: '1', title: 'a.txt', focused: true }),
          win({ processName: 'regedit', id: '2', elevated: true }),
        ],
      }),
    });
    const result = await r.run('list_windows', {});
    expect(result).toMatchObject({
      status: 'success',
      permission: 'allowed',
      output: { count: 2 },
    });
    expect((result.output as { windows: Array<{ elevated?: boolean }> }).windows[1]!.elevated).toBe(
      true,
    );
  });

  it('focusing is LOW risk and verified', async () => {
    const r = setup({
      adapter: new MemoryAdapter({
        windows: [
          win({ processName: 'chrome', id: '7' }),
          win({ processName: 'notepad', id: '1', focused: true }),
        ],
      }),
    });
    const result = await r.run('focus_window', { windowId: '7' });
    expect(result).toMatchObject({ status: 'success', risk: 'LOW', verification: 'verified' });
    expect((await r.adapter.listWindows()).find((w) => w.focused)?.id).toBe('7');
  });

  it('rejects malformed window ids', async () => {
    const r = setup();
    for (const windowId of ['', 'abc', '1; calc', '-1'])
      expect((await r.run('focus_window', { windowId })).status, windowId).toBe('invalid');
  });
});

describe('typing and keys', () => {
  it('asks before typing, then types — and says honestly that it cannot confirm the result', async () => {
    const r = setup();
    const pending = r.run('type_text', { text: 'আমি ভালো আছি' });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.broker.pending()[0]!.summary).toBe('Type “আমি ভালো আছি” into the window in front');
    expect(r.adapter.typed).toEqual([]);
    r.broker.respond(r.broker.pending()[0]!.id, 'approved', 'ui');
    const result = await pending;
    expect(result).toMatchObject({ status: 'success', ok: true, verification: 'unverified' });
    expect(r.adapter.typed).toEqual(['আমি ভালো আছি']);
  });

  it('never puts the typed text in the audit trail — only how much was typed', async () => {
    const r = setup({ modes: { computer_control: 'always_allow' } });
    const secret = 'MyPassword123!';
    const result = await r.run('type_text', { text: secret });
    expect(result.status).toBe('success');
    const stored = JSON.stringify([r.audit.begun, r.audit.finished.map((f) => f.auditSummary)]);
    expect(stored).not.toContain(secret);
    expect(r.audit.begun[0]!.summary).toBe('Type 14 characters');
    expect(r.audit.begun[0]!.arguments).toEqual({ characters: 14 });
  });

  it('cannot type into a terminal — the failure reaches the model as a normal error', async () => {
    const r = setup({
      adapter: new MemoryAdapter({
        windows: [win({ processName: 'powershell', id: '1', focused: true })],
      }),
      modes: { computer_control: 'always_allow' },
    });
    const result = await r.run('type_text', { text: 'Remove-Item -Recurse C:\\' });
    expect(result).toMatchObject({
      status: 'failed',
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    expect(r.adapter.typed).toEqual([]);
  });

  it('refuses blocked shortcuts and describes allowed ones readably', async () => {
    const r = setup({ modes: { computer_control: 'always_allow' } });
    expect(await r.run('press_keys', { keys: 'win+r' })).toMatchObject({
      status: 'failed',
      error: { code: 'PERMISSION_DENIED' },
    });
    expect(await r.run('press_keys', { keys: 'alt+f4' })).toMatchObject({
      status: 'failed',
      error: { code: 'PERMISSION_DENIED' },
    });
    const ok = await r.run('press_keys', { keys: 'control + s' });
    expect(ok).toMatchObject({
      status: 'success',
      summary: 'Press Ctrl+S',
      output: { pressed: 'Ctrl+S' },
    });
    expect(r.adapter.chords).toEqual([{ modifiers: ['ctrl'], key: 's' }]);
    expect((await r.run('press_keys', { keys: 'ctrl+banana' })).status).toBe('failed');
  });

  it('bounds the amount of text at the schema, before anything else', async () => {
    const r = setup({ modes: { computer_control: 'always_allow' } });
    expect((await r.run('type_text', { text: 'x'.repeat(2001) })).status).toBe('invalid');
    expect((await r.run('type_text', { text: '' })).status).toBe('invalid');
  });
});

describe('mouse and controls', () => {
  it('blind clicks are HIGH risk and always ask', async () => {
    const r = setup();
    const pending = r.run('click_at', { x: 100, y: 100 });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.broker.pending()[0]).toMatchObject({ risk: 'HIGH', summary: 'Click at (100, 100)' });
    expect(r.adapter.clicks).toEqual([]);
    r.broker.respond(r.broker.pending()[0]!.id, 'approved', 'ui');
    expect((await pending).ok).toBe(true);
    expect(r.adapter.clicks).toEqual([{ x: 100, y: 100, button: 'left', count: 1 }]);
  });

  it('clicking a control by name reports when it does not exist', async () => {
    const r = setup({
      adapter: new MemoryAdapter({
        windows: [win({ processName: 'notepad', id: '1', focused: true })],
        elements: ['Save'],
      }),
      modes: { computer_control: 'always_allow' },
    });
    expect(await r.run('click_element', { windowId: '1', name: 'Save' })).toMatchObject({
      status: 'success',
      output: { clicked: 'Save' },
    });
    expect(await r.run('click_element', { windowId: '1', name: 'Nope' })).toMatchObject({
      status: 'failed',
      error: { code: 'NOT_FOUND' },
    });
  });

  it('scrolling is harmless (LOW) and bounded', async () => {
    const r = setup();
    expect(await r.run('scroll', { amount: -240 })).toMatchObject({
      status: 'success',
      risk: 'LOW',
    });
    expect(r.adapter.scrolls).toEqual([-240]);
    expect((await r.run('scroll', { amount: 99999 })).status).toBe('invalid');
  });
});

describe('screenshots and clipboard', () => {
  it('saves a screenshot and verifies the file is a real PNG', async () => {
    const r = setup();
    const result = await r.run('take_screenshot', {});
    expect(result).toMatchObject({
      status: 'success',
      verification: 'verified',
      risk: 'LOW',
      output: { path: '/shots/shot-1.png', width: 1, height: 1, bytes: TINY_PNG.byteLength },
    });
    expect(result.evidence).toMatch(/PNG file exists/);
  });

  it('a missing or corrupt file is not reported as a screenshot', async () => {
    const missing = setup();
    missing.store.missing = true;
    expect(await missing.run('take_screenshot', {})).toMatchObject({
      ok: false,
      verification: 'failed',
      error: { code: 'VERIFICATION_FAILED' },
    });
    const corrupt = setup();
    corrupt.store.corrupt = true;
    const result = await corrupt.run('take_screenshot', {});
    expect(result).toMatchObject({ ok: false, verification: 'failed' });
    expect(result.evidence).toMatch(/not a valid PNG/);
  });

  it('reading the clipboard asks first (it can hold passwords) and bounds what the model sees', async () => {
    const r = setup();
    r.adapter.clipboard = 'x'.repeat(10_000);
    const result = await r.runApproved('read_clipboard', {});
    expect(result).toMatchObject({
      status: 'success',
      risk: 'MEDIUM',
      output: { characters: 10_000, truncated: true },
    });
    expect((result.output as { text: string }).text).toHaveLength(4000);
    // The audit says a read happened, never what was on the clipboard.
    expect(JSON.stringify(r.audit.finished.map((f) => f.auditSummary))).not.toContain('xxxxxxxx');
  });

  it('writing the clipboard is verified by reading it back, and its text stays out of the audit trail', async () => {
    const r = setup();
    const result = await r.runApproved('write_clipboard', { text: 'secret-token-abc' });
    expect(result).toMatchObject({ status: 'success', verification: 'verified' });
    expect(r.adapter.clipboard).toBe('secret-token-abc');
    expect(
      JSON.stringify([r.audit.begun, r.audit.finished.map((f) => f.auditSummary)]),
    ).not.toContain('secret-token-abc');
  });

  it('a clipboard that did not take the text is a failure', async () => {
    const r = setup();
    r.adapter.setClipboardText = async () => undefined; // silently ignored, like a locked clipboard
    expect(await r.runApproved('write_clipboard', { text: 'hello' })).toMatchObject({
      ok: false,
      verification: 'failed',
    });
  });
});
