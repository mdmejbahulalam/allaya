import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_ENCODED_LENGTH,
  NATIVE_CSHARP,
  SCRIPTS,
  WindowsAdapter,
  powershellArguments,
  virtualKey,
  type ScriptRunner,
} from '@allaya/computer';

/** A runner that records what it was asked and answers from a table keyed by the script it received. */
function fakeRunner(replies: Partial<Record<keyof typeof SCRIPTS, unknown>> = {}) {
  const calls: Array<{ name: string; script: string; args: unknown }> = [];
  const runner: ScriptRunner = {
    async run(script, args) {
      const name = (Object.keys(SCRIPTS) as Array<keyof typeof SCRIPTS>).find(
        (n) => SCRIPTS[n] === script,
      );
      if (!name) throw new Error('an unknown script was run');
      calls.push({ name, script, args });
      const reply = replies[name] ?? { ok: true };
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  };
  return { runner, calls };
}

describe('Windows adapter: listing windows', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: '198420',
    title: 'Untitled - Notepad',
    processName: 'Notepad',
    pid: 1234,
    x: 10,
    y: 20,
    width: 800,
    height: 600,
    minimized: false,
    focused: true,
    elevated: false,
    ...over,
  });

  it('maps the helper output to window info', async () => {
    const { runner } = fakeRunner({
      listWindows: {
        windows: [
          raw(),
          raw({
            id: '5',
            processName: 'chrome',
            focused: false,
            elevated: true,
            title: 'বাংলা পাতা',
          }),
        ],
      },
    });
    const windows = await new WindowsAdapter(runner).listWindows();
    expect(windows).toEqual([
      {
        id: '198420',
        title: 'Untitled - Notepad',
        processName: 'notepad',
        pid: 1234,
        bounds: { x: 10, y: 20, width: 800, height: 600 },
        focused: true,
        minimized: false,
        elevated: false,
      },
      expect.objectContaining({
        id: '5',
        processName: 'chrome',
        title: 'বাংলা পাতা',
        elevated: true,
        focused: false,
      }),
    ]);
  });

  it('accepts the shapes PowerShell produces for zero and one window', async () => {
    expect(
      await new WindowsAdapter(fakeRunner({ listWindows: { windows: null } }).runner).listWindows(),
    ).toEqual([]);
    expect(
      await new WindowsAdapter(fakeRunner({ listWindows: { windows: [] } }).runner).listWindows(),
    ).toEqual([]);
    const single = await new WindowsAdapter(
      fakeRunner({ listWindows: { windows: raw() } }).runner,
    ).listWindows();
    expect(single).toHaveLength(1);
  });

  it('finds the helper answer even when a launched program printed something first', async () => {
    const noisy = `hello from a console app\n${JSON.stringify({ pid: 9 })}\n`;
    expect(
      await new WindowsAdapter(fakeRunner({ launch: noisy }).runner).launch({ executable: 'cmd' }),
    ).toEqual({ pid: 9 });
  });

  it('treats unreadable helper output as an error, not as "no windows"', async () => {
    await expect(
      new WindowsAdapter(fakeRunner({ listWindows: 'Error: something' }).runner).listWindows(),
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
  });
});

describe('Windows adapter: data never becomes code', () => {
  const HOSTILE = `"; Remove-Item -Recurse C:\\ ; '$(calc)' \`n & { evil } ${'\u0995'}`;

  it('sends text only as JSON arguments; the script text is identical whatever the input', async () => {
    const { runner, calls } = fakeRunner();
    const adapter = new WindowsAdapter(runner);
    await adapter.typeText(HOSTILE);
    await adapter.typeText('something else');
    expect(calls[0]!.script).toBe(calls[1]!.script);
    expect(calls[0]!.script).toBe(SCRIPTS.typeText);
    expect(calls[0]!.script).not.toContain('Remove-Item');
    expect(calls[0]!.args).toEqual({ text: HOSTILE });
  });

  it('refuses anything but plain application names for launching', async () => {
    const { runner, calls } = fakeRunner({ launch: { pid: 77 } });
    const adapter = new WindowsAdapter(runner);
    expect(await adapter.launch({ executable: 'notepad' })).toEqual({ pid: 77 });
    expect(await adapter.launch({ executable: 'ms-teams' })).toEqual({ pid: 77 });
    for (const executable of [
      'C:\\Windows\\notepad.exe',
      'cmd /c calc',
      'a b',
      'a;b',
      'a|b',
      '"x"',
      '../x',
      '',
      'x'.repeat(65),
      'a&b',
      'a`b',
      '$env:X',
    ]) {
      await expect(adapter.launch({ executable }), executable).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
    expect(calls).toHaveLength(2);
  });

  it('accepts only numeric window handles', async () => {
    const { runner, calls } = fakeRunner();
    const adapter = new WindowsAdapter(runner);
    await adapter.focusWindow('198420');
    await adapter.closeWindow('7');
    for (const id of ['', 'abc', '12 34', '1;2', '-1', '1.5', '9'.repeat(21), '0x10', '$(x)']) {
      await expect(adapter.focusWindow(id), id).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(adapter.closeWindow(id), id).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(adapter.invokeElement({ windowId: id, name: 'x' }), id).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    }
    expect(calls.map((c) => c.args)).toEqual([{ id: '198420' }, { id: '7' }]);
  });

  it('passes element names as data', async () => {
    const { runner, calls } = fakeRunner({ invokeElement: { found: true } });
    expect(
      await new WindowsAdapter(runner).invokeElement({
        windowId: '1',
        name: HOSTILE,
        role: 'button',
      }),
    ).toBe(true);
    expect(calls[0]!.args).toEqual({ windowId: '1', name: HOSTILE, controlType: 'button' });
    expect(calls[0]!.script).not.toContain('Remove-Item');
  });

  it('rounds coordinates and passes mouse arguments', async () => {
    const { runner, calls } = fakeRunner();
    const adapter = new WindowsAdapter(runner);
    await adapter.clickMouse(100.6, 200.4, 'right', 2);
    await adapter.moveMouse(1.2, 3.8);
    await adapter.scroll(-120.4);
    expect(calls.map((c) => c.args)).toEqual([
      { x: 101, y: 200, button: 'right', count: 2 },
      { x: 1, y: 4 },
      { delta: -120 },
    ]);
  });

  it('turns shortcuts into virtual-key codes, modifiers first', async () => {
    const { runner, calls } = fakeRunner();
    const adapter = new WindowsAdapter(runner);
    await adapter.pressKeys({ modifiers: ['ctrl', 'shift'], key: 't' });
    await adapter.pressKeys({ modifiers: [], key: 'f5' });
    await adapter.pressKeys({ modifiers: ['alt'], key: 'left' });
    expect(calls.map((c) => c.args)).toEqual([
      { modifiers: [0x11, 0x10], key: 0x54 },
      { modifiers: [], key: 0x74 },
      { modifiers: [0x12], key: 0x25 },
    ]);
    await expect(adapter.pressKeys({ modifiers: [], key: 'printscreen' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('has a virtual-key code for every key the parser accepts, and none for anything else', () => {
    for (const key of [
      'a',
      'z',
      '0',
      '9',
      'f1',
      'f12',
      'enter',
      'tab',
      'escape',
      'space',
      'backspace',
      'delete',
      'home',
      'end',
      'pageup',
      'pagedown',
      'up',
      'down',
      'left',
      'right',
      'insert',
    ]) {
      expect(virtualKey(key), key).toBeTypeOf('number');
    }
    expect(virtualKey('a')).toBe(0x41);
    expect(virtualKey('f1')).toBe(0x70);
    expect(virtualKey('f12')).toBe(0x7b);
    for (const key of ['f13', 'ctrl', 'volumeup', '', 'ab'])
      expect(virtualKey(key), key).toBeUndefined();
  });

  it('only advertises what it implements; screenshots, clipboard and displays come from the host', async () => {
    const adapter = new WindowsAdapter(fakeRunner().runner);
    expect(adapter.capabilities()).toEqual({
      windows: true,
      launch: true,
      screenshot: false,
      clipboard: false,
      mouse: true,
      keyboard: true,
      uiAutomation: true,
    });
    await expect(adapter.screenshot()).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(adapter.getClipboardText()).rejects.toMatchObject({
      code: 'UNSUPPORTED_PLATFORM',
    });
  });
});

describe('PowerShell programs', () => {
  it('fit on a Windows command line as -EncodedCommand', () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      const args = powershellArguments(script);
      expect(args.slice(0, 4), name).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
      ]);
      expect(args[4]).toBe('-EncodedCommand');
      expect(args[5]!.length, name).toBeLessThan(MAX_ENCODED_LENGTH);
      expect(Buffer.from(args[5]!, 'base64').toString('utf16le'), name).toBe(script);
    }
  });

  it('read their input only from ALLAYA_ARGS and have no interpolation holes', () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      expect(script, name).toContain('$env:ALLAYA_ARGS');
      expect(script, name).not.toMatch(/\$\{|%s|\{\{|undefined|\[object/);
    }
  });

  it('refuses to run a program too large for the command line', () => {
    expect(() => powershellArguments('x'.repeat(20_000))).toThrow(/too large/);
  });
});

// ── Optional deeper checks: run only where the tools exist (never required, never faked) ─────────────────────────
const which = (candidates: string[], probe: string[]): string | undefined =>
  candidates.find((c) => {
    try {
      return (
        spawnSync(c, probe, {
          encoding: 'utf8',
          env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
        }).status === 0
      );
    } catch {
      return false;
    }
  });
const pwsh = which(
  [process.env['PWSH'] ?? 'pwsh', '/tmp/pwsh/pwsh'].filter((p) => p === 'pwsh' || existsSync(p)),
  ['-NoProfile', '-Command', '1'],
);
const mcs = which(['mcs'], ['--version']);

describe.skipIf(!pwsh)('PowerShell programs — real parser (pwsh found)', () => {
  it('every program parses without errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-ps-'));
    const results = Object.entries(SCRIPTS).map(([name, script]) => {
      const file = join(dir, `${name}.ps1`);
      writeFileSync(file, script);
      const run = spawnSync(
        pwsh!,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e)|Out-Null; if($e.Count -gt 0){$e|%{$_.Message};exit 1}`,
        ],
        { encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } },
      );
      return { name, status: run.status, out: run.stdout };
    });
    expect(results.filter((r) => r.status !== 0)).toEqual([]);
  });

  it('the launch program treats shell metacharacters in arguments as plain data', () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'allaya-inj-')), 'pwned');
    const result = spawnSync(
      pwsh!,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(SCRIPTS.launch, 'utf16le').toString('base64'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
          ALLAYA_ARGS: JSON.stringify({
            executable: 'echo',
            arguments: [`x; touch ${marker}`, '$(touch ' + marker + ')'],
          }),
        },
      },
    );
    expect(result.status).toBe(0);
    const answer =
      result.stdout
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .pop() ?? '';
    expect(JSON.parse(answer)).toMatchObject({ pid: expect.any(Number) });
    expect(existsSync(marker)).toBe(false);
  });
});

describe.skipIf(!mcs)('Win32 interop — real C# compiler (mcs found)', () => {
  it('compiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-cs-'));
    writeFileSync(join(dir, 'Native.cs'), NATIVE_CSHARP);
    const run = spawnSync(
      'mcs',
      ['-target:library', `-out:${join(dir, 'Native.dll')}`, join(dir, 'Native.cs')],
      { encoding: 'utf8' },
    );
    expect(run.stdout + run.stderr).not.toMatch(/error CS/);
    expect(run.status).toBe(0);
  });
});

describe('Windows adapter: which catalog apps are installed', () => {
  const items = [
    { name: 'Chrome', executable: 'chrome' },
    { name: 'VS Code', executable: 'code' },
    { name: '3ds Max', executable: '3dsmax' },
  ];

  it('sends only plain catalog names to the script, as data, and returns what it found', async () => {
    const { runner, calls } = fakeRunner({ installedApps: { installed: ['Chrome', '3ds Max'] } });
    const adapter = new WindowsAdapter(runner);
    expect(await adapter.installedApps(items)).toEqual(['Chrome', '3ds Max']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('installedApps');
    expect(calls[0]!.args).toEqual({ items });
  });

  it('never lets text that is not a plain name reach the script, and ignores names it did not ask about', async () => {
    const { runner, calls } = fakeRunner({
      installedApps: { installed: ['Chrome', 'Surprise'] },
    });
    const adapter = new WindowsAdapter(runner);
    const found = await adapter.installedApps([
      { name: 'Chrome', executable: 'chrome' },
      { name: 'Evil', executable: 'a; Remove-Item C:\\ -Recurse' },
      { name: 'Bad `name`', executable: 'ok' },
      { name: 'Spaces', executable: 'has space' },
    ]);
    expect(found).toEqual(['Chrome']);
    expect(calls[0]!.args).toEqual({ items: [{ name: 'Chrome', executable: 'chrome' }] });
  });

  it('accepts the shapes PowerShell produces for none and for one', async () => {
    const none = new WindowsAdapter(fakeRunner({ installedApps: { installed: null } }).runner);
    expect(await none.installedApps(items)).toEqual([]);
    const one = new WindowsAdapter(fakeRunner({ installedApps: { installed: 'Chrome' } }).runner);
    expect(await one.installedApps(items)).toEqual(['Chrome']);
  });

  it('the script is a constant that takes its data only from the environment', () => {
    expect(SCRIPTS.installedApps).toContain('$env:ALLAYA_ARGS');
    expect(SCRIPTS.installedApps).not.toMatch(/\$\{|Invoke-Expression|iex\b/i);
    expect(powershellArguments(SCRIPTS.installedApps).join(' ').length).toBeLessThan(
      MAX_ENCODED_LENGTH,
    );
  });
});
