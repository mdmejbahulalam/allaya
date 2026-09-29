import { describe, expect, it } from 'vitest';
import {
  ComputerEngine,
  MAX_TYPED_CHARS,
  MemoryAdapter,
  CompositeAdapter,
  type WindowInfo,
} from '@allaya/computer';

const OWN_PID = 4242;

const rig = (
  over: {
    windows?: WindowInfo[];
    adapter?: MemoryAdapter;
    rate?: { max: number; windowMs: number };
    waitMs?: number;
  } = {},
) => {
  const adapter = over.adapter ?? new MemoryAdapter({ windows: over.windows ?? [] });
  const engine = new ComputerEngine({
    adapter,
    ownPid: OWN_PID,
    waitMs: over.waitMs ?? 300,
    pollMs: 10,
    ...(over.rate ? { rate: over.rate } : {}),
  });
  return { adapter, engine };
};

const win = (over: Partial<WindowInfo> & { processName: string }): WindowInfo => ({
  id: over.id ?? over.processName,
  title: over.title ?? over.processName,
  pid: 1,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: false,
  minimized: false,
  ...over,
});

describe('opening apps', () => {
  it('launches a catalog app and reports the window that appeared', async () => {
    const { adapter, engine } = rig();
    const result = await engine.openApp('Notepad');
    expect(adapter.launched).toEqual(['notepad']);
    expect(result).toMatchObject({
      app: { name: 'Notepad' },
      alreadyOpen: false,
      window: { processName: 'notepad' },
    });
  });

  it('never launches something that is not in the catalog — no paths, no commands', async () => {
    const { adapter, engine } = rig();
    for (const name of [
      'C:\\Windows\\System32\\calc.exe',
      'cmd /c calc',
      'totally-unknown-app',
      'notepad; format c:',
    ]) {
      await expect(engine.openApp(name), name).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(adapter.launched).toEqual([]);
  });

  it('says so when the window never shows up, instead of claiming success', async () => {
    const adapter = new MemoryAdapter({ windowsAppearOnLaunch: false });
    const { engine } = rig({ adapter, waitMs: 60 });
    const result = await engine.openApp('Chrome');
    expect(adapter.launched).toEqual(['chrome']);
    expect(result.window).toBeUndefined();
  });

  it('recognises an app that was already open (single-instance apps reuse their window)', async () => {
    const { engine } = rig({ windows: [win({ processName: 'chrome', id: '7' })] });
    const result = await engine.openApp('chrome');
    expect(result.alreadyOpen).toBe(true);
    expect(result.window?.processName).toBe('chrome');
  });

  it('can be cancelled while waiting for the window', async () => {
    const adapter = new MemoryAdapter({ windowsAppearOnLaunch: false });
    const { engine } = rig({ adapter, waitMs: 5000 });
    const controller = new AbortController();
    const pending = engine.openApp('Chrome', controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('closing apps', () => {
  it('asks the windows to close and confirms they are gone', async () => {
    const { adapter, engine } = rig({
      windows: [
        win({ processName: 'notepad', id: '1' }),
        win({ processName: 'notepad', id: '2' }),
        win({ processName: 'chrome', id: '3' }),
      ],
    });
    const result = await engine.closeApp('Notepad');
    expect(adapter.closed.sort()).toEqual(['1', '2']);
    expect(result).toMatchObject({ closed: 2, remaining: 0 });
    expect((await adapter.listWindows()).map((w) => w.id)).toEqual(['3']); // Chrome untouched
  });

  it('reports windows that refused to close (e.g. "save changes?") rather than pretending', async () => {
    const adapter = new MemoryAdapter({
      windows: [win({ processName: 'notepad', id: '1' })],
      windowsCloseOnRequest: false,
    });
    const { engine } = rig({ adapter, waitMs: 60 });
    expect(await engine.closeApp('notepad')).toMatchObject({ closed: 0, remaining: 1 });
  });

  it('refuses an app that is not open, and an unknown app', async () => {
    const { engine } = rig();
    await expect(engine.closeApp('Notepad')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(engine.closeApp('mystery')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("never closes Allaya's own windows", async () => {
    const { adapter, engine } = rig({
      windows: [win({ processName: 'code', pid: OWN_PID, id: 'me' })],
    });
    await expect(engine.closeApp('VS Code')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(adapter.closed).toEqual([]);
  });
});

describe('typing and shortcuts: where input may go', () => {
  it('types into a normal window and returns the target', async () => {
    const { adapter, engine } = rig({
      windows: [win({ processName: 'notepad', id: '1', focused: true })],
    });
    const { target } = await engine.typeText('আমি ভালো আছি — hello', '1');
    expect(adapter.typed).toEqual(['আমি ভালো আছি — hello']);
    expect(target.processName).toBe('notepad');
  });

  it('brings the requested window to the front first, and refuses if it cannot', async () => {
    const { adapter, engine } = rig({
      windows: [
        win({ processName: 'chrome', id: '1', focused: true }),
        win({ processName: 'notepad', id: '2' }),
      ],
    });
    await engine.typeText('hi', '2');
    expect(adapter.focusedIds).toEqual(['2']);
    expect(adapter.typed).toEqual(['hi']);
    // A window that will not take focus must not silently receive input in the wrong place.
    adapter.focusWindow = async () => undefined; // focus request ignored
    await adapter.listWindows().then((ws) => ws.forEach((w) => void w));
    adapter.windows.forEach((w) => (w.focused = w.id === '1'));
    await expect(engine.typeText('nope', '2')).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
    });
    expect(adapter.typed).toEqual(['hi']);
  });

  it.each([
    'cmd',
    'powershell',
    'pwsh',
    'windowsterminal',
    'conhost',
    'regedit',
    'taskmgr',
    'mmc',
    'consent',
  ])(
    'refuses to type into %s, which can run commands or change the system',
    async (processName) => {
      const { adapter, engine } = rig({ windows: [win({ processName, id: '1', focused: true })] });
      await expect(engine.typeText('del /s /q *.*', '1')).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      await expect(engine.pressKeys('enter', '1')).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      expect(adapter.typed).toEqual([]);
      expect(adapter.chords).toEqual([]);
    },
  );

  it('refuses elevated (administrator) windows and Allaya itself', async () => {
    const elevated = rig({
      windows: [win({ processName: 'notepad', id: '1', focused: true, elevated: true })],
    });
    await expect(elevated.engine.typeText('x', '1')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const self = rig({
      windows: [win({ processName: 'allaya', id: '1', focused: true, pid: OWN_PID })],
    });
    await expect(self.engine.typeText('x', '1')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(self.engine.typeText('x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('checks the window that actually has focus when no window is named', async () => {
    const { adapter, engine } = rig({
      windows: [win({ processName: 'powershell', id: '1', focused: true })],
    });
    await expect(engine.typeText('Remove-Item -Recurse C:\\')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(adapter.typed).toEqual([]);
  });

  it('has nowhere to send input when nothing has focus', async () => {
    const { engine } = rig({ windows: [win({ processName: 'notepad', id: '1' })] });
    await expect(engine.typeText('hi')).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
  });

  it('bounds the amount of text and refuses empty text', async () => {
    const { adapter, engine } = rig({
      windows: [win({ processName: 'notepad', id: '1', focused: true })],
    });
    await expect(engine.typeText('x'.repeat(MAX_TYPED_CHARS + 1))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(engine.typeText('')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await engine.typeText('x'.repeat(MAX_TYPED_CHARS));
    expect(adapter.typed[0]).toHaveLength(MAX_TYPED_CHARS);
  });

  it('presses safe shortcuts and refuses ones that leave the window', async () => {
    const { adapter, engine } = rig({
      windows: [win({ processName: 'notepad', id: '1', focused: true })],
    });
    await engine.pressKeys('Ctrl+S');
    expect(adapter.chords).toEqual([{ modifiers: ['ctrl'], key: 's' }]);
    for (const chord of ['win+r', 'alt+f4', 'ctrl+alt+delete', 'ctrl+shift+esc']) {
      await expect(engine.pressKeys(chord), chord).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
    }
    expect(adapter.chords).toHaveLength(1);
    await expect(engine.pressKeys('ctrl+banana')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('mouse', () => {
  it('clicks on screen and refuses coordinates off every display', async () => {
    const { adapter, engine } = rig({
      windows: [
        win({
          processName: 'notepad',
          id: '1',
          focused: true,
          bounds: { x: 100, y: 100, width: 300, height: 300 },
        }),
      ],
    });
    await engine.click(150, 150, 'left', 2);
    expect(adapter.clicks).toEqual([{ x: 150, y: 150, button: 'left', count: 2 }]);
    for (const [x, y] of [
      [-1, 10],
      [1920, 10],
      [10, 1080],
      [99999, 99999],
    ] as const) {
      await expect(engine.click(x, y), `${x},${y}`).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
  });

  it('refuses to click inside a sensitive or elevated window, even when another window has focus', async () => {
    const { adapter, engine } = rig({
      windows: [
        win({
          processName: 'notepad',
          id: '1',
          focused: true,
          bounds: { x: 0, y: 0, width: 500, height: 500 },
        }),
        win({ processName: 'cmd', id: '2', bounds: { x: 600, y: 0, width: 400, height: 400 } }),
        win({
          processName: 'notepad',
          id: '3',
          elevated: true,
          bounds: { x: 0, y: 700, width: 400, height: 300 },
        }),
      ],
    });
    await expect(engine.click(700, 100)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(engine.click(100, 800)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await engine.click(100, 100);
    expect(adapter.clicks).toHaveLength(1);
  });

  it('ignores minimised windows when deciding what is under the pointer', async () => {
    const { adapter, engine } = rig({
      windows: [
        win({
          processName: 'cmd',
          id: '2',
          minimized: true,
          bounds: { x: 0, y: 0, width: 500, height: 500 },
        }),
      ],
    });
    await engine.click(100, 100);
    expect(adapter.clicks).toHaveLength(1);
  });

  it('validates scroll amounts', async () => {
    const { adapter, engine } = rig();
    await engine.scroll(-300);
    expect(adapter.scrolls).toEqual([-300]);
    for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY, 9999])
      await expect(engine.scroll(bad), String(bad)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
  });
});

describe('UI automation', () => {
  it('activates a control by name in a normal window; reports when it is not there', async () => {
    const adapter = new MemoryAdapter({
      windows: [win({ processName: 'notepad', id: '1', focused: true })],
      elements: ['Save'],
    });
    const { engine } = rig({ adapter });
    expect(await engine.invokeElement({ windowId: '1', name: 'save' })).toBe(true);
    expect(await engine.invokeElement({ windowId: '1', name: 'Delete everything' })).toBe(false);
  });

  it('will not automate a shell, an elevated window, or a window that is gone', async () => {
    const adapter = new MemoryAdapter({
      windows: [
        win({ processName: 'cmd', id: '1' }),
        win({ processName: 'notepad', id: '2', elevated: true }),
      ],
      elements: ['OK'],
    });
    const { engine } = rig({ adapter });
    await expect(engine.invokeElement({ windowId: '1', name: 'OK' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(engine.invokeElement({ windowId: '2', name: 'OK' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(engine.invokeElement({ windowId: '99', name: 'OK' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(adapter.invoked).toEqual([]);
  });
});

describe('rate limiting', () => {
  it('stops a runaway loop hammering the desktop, then recovers', async () => {
    let now = 0;
    const adapter = new MemoryAdapter({
      windows: [win({ processName: 'notepad', id: '1', focused: true })],
    });
    const engine = new ComputerEngine({
      adapter,
      ownPid: OWN_PID,
      now: () => now,
      rate: { max: 3, windowMs: 1000 },
    });
    for (let i = 0; i < 3; i += 1) await engine.typeText('a');
    await expect(engine.typeText('a')).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      retryable: true,
    });
    now += 1001;
    await engine.typeText('a');
    expect(adapter.typed).toHaveLength(4);
  });

  it('counts every kind of input against the same budget', async () => {
    const now = 0;
    const adapter = new MemoryAdapter({
      windows: [win({ processName: 'notepad', id: '1', focused: true })],
    });
    const engine = new ComputerEngine({
      adapter,
      ownPid: OWN_PID,
      now: () => now,
      rate: { max: 2, windowMs: 1000 },
    });
    await engine.typeText('a');
    await engine.click(10, 10);
    await expect(engine.pressKeys('enter')).rejects.toMatchObject({ retryable: true });
  });
});

describe('capabilities', () => {
  it('refuses features the platform lacks, naming the missing capability', async () => {
    const adapter = new MemoryAdapter({
      capabilities: {
        keyboard: false,
        mouse: false,
        uiAutomation: false,
        windows: false,
        launch: false,
      },
    });
    const { engine } = rig({ adapter });
    for (const call of [
      () => engine.typeText('x'),
      () => engine.pressKeys('enter'),
      () => engine.click(1, 1),
      () => engine.listWindows(),
      () => engine.openApp('Chrome'),
      () => engine.invokeElement({ windowId: '1', name: 'x' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    }
    expect(adapter.launched).toEqual([]);
  });

  it('a host-only setup (e.g. Linux) can screenshot and use the clipboard, and nothing else', async () => {
    const host = new MemoryAdapter();
    const engine = new ComputerEngine({
      adapter: new CompositeAdapter(undefined, host, 'linux'),
      ownPid: OWN_PID,
    });
    expect(engine.capabilities()).toEqual({
      windows: false,
      launch: false,
      screenshot: true,
      clipboard: true,
      mouse: false,
      keyboard: false,
      uiAutomation: false,
    });
    expect((await engine.screenshot()).mimeType).toBe('image/png');
    host.clipboard = 'copied';
    expect(await engine.getClipboardText()).toBe('copied');
    await expect(engine.openApp('Chrome')).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(engine.typeText('x')).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  });
});
