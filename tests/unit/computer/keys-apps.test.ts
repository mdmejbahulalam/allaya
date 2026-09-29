import { describe, expect, it } from 'vitest';
import {
  APP_CATALOG,
  SENSITIVE_PROCESSES,
  SHELL_PROCESSES,
  blockedChordReason,
  formatChord,
  isKnownKey,
  parseChord,
  resolveApp,
} from '@allaya/computer';
import { KNOWN_APP_NAMES } from '@allaya/language';

describe('keyboard shortcuts', () => {
  it('parses shortcuts case- and space-insensitively, with modifier synonyms', () => {
    expect(parseChord('Ctrl+Shift+T')).toEqual({ modifiers: ['ctrl', 'shift'], key: 't' });
    expect(parseChord('control + c')).toEqual({ modifiers: ['ctrl'], key: 'c' });
    expect(parseChord('Enter')).toEqual({ modifiers: [], key: 'enter' });
    expect(parseChord('alt+F4')).toEqual({ modifiers: ['alt'], key: 'f4' });
    expect(parseChord('Ctrl+Ctrl+A').modifiers).toEqual(['ctrl']);
    expect(parseChord('Esc')).toEqual({ modifiers: [], key: 'escape' });
    expect(parseChord('ctrl+Del').key).toBe('delete');
    expect(parseChord('Return').key).toBe('enter');
    expect(parseChord('alt+ArrowLeft')).toEqual({ modifiers: ['alt'], key: 'left' });
  });

  it.each([
    '',
    '   ',
    '+',
    'ctrl+',
    'ctrl+shift',
    'ctrl+banana',
    'foo+c',
    'a+b',
    'f13',
    'ctrl+f0',
    'ctrl+é',
    'ctrl+ক',
  ])('rejects %j', (text) => {
    expect(() => parseChord(text)).toThrow();
  });

  it('knows exactly the keys it will press', () => {
    for (const key of [
      'a',
      'Z',
      '0',
      '9',
      'f1',
      'F12',
      'enter',
      'tab',
      'Escape',
      'space',
      'PageDown',
      'left',
    ])
      expect(isKnownKey(key), key).toBe(true);
    for (const key of ['f13', 'printscreen', 'ab', '', 'ctrl', 'shift', '-', '/'])
      expect(isKnownKey(key), key).toBe(false);
  });

  it('formats a chord for humans', () => {
    expect(formatChord(parseChord('ctrl+shift+t'))).toBe('Ctrl+Shift+T');
    expect(formatChord(parseChord('alt+f4'))).toBe('Alt+F4');
  });

  it.each([
    'win+r',
    'win+d',
    'windows+l',
    'meta+e',
    'alt+f4',
    'ctrl+alt+delete',
    'ctrl+shift+escape',
    'ctrl+win+d',
  ])('blocks %s', (text) => {
    expect(blockedChordReason(parseChord(text)), text).toBeTruthy();
  });

  it.each([
    'ctrl+c',
    'ctrl+v',
    'ctrl+shift+t',
    'alt+left',
    'ctrl+alt+t',
    'enter',
    'f5',
    'ctrl+w',
    'alt+tab',
  ])('allows %s', (text) => {
    expect(blockedChordReason(parseChord(text)), text).toBeUndefined();
  });
});

describe('app catalog', () => {
  it('resolves names case-, spacing- and punctuation-insensitively', () => {
    expect(resolveApp('Chrome')?.windows).toBe('chrome');
    expect(resolveApp('  vs code ')?.name).toBe('VS Code');
    expect(resolveApp('vs-code')?.name).toBe('VS Code');
    expect(resolveApp('MICROSOFT.EDGE')).toBeUndefined(); // only canonical names, not free text
    expect(resolveApp('command prompt')?.shell).toBe(true);
  });

  it('never resolves paths, commands or shell text — that is the whole point of the catalog', () => {
    for (const text of [
      'C:\\Windows\\System32\\cmd.exe',
      'cmd /c del *.*',
      'chrome; rm -rf',
      '../../evil',
      'powershell -enc AAAA',
      '',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(resolveApp(text), text).toBeUndefined();
    }
  });

  it('has unique names and plain executable names (no paths, spaces or shell characters)', () => {
    const names = APP_CATALOG.map((a) => a.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const app of APP_CATALOG) {
      expect(app.windows, app.name).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(app.processes.length, app.name).toBeGreaterThan(0);
    }
  });

  it('marks shells as MEDIUM risk and refuses them input; everything else is LOW', () => {
    for (const app of APP_CATALOG) {
      if (app.shell) expect(app.risk, app.name).toBe('MEDIUM');
      else expect(app.risk, app.name).toBe('LOW');
    }
    for (const shell of ['cmd', 'powershell', 'pwsh', 'windowsterminal', 'conhost', 'bash']) {
      expect(SHELL_PROCESSES.has(shell), shell).toBe(true);
      expect(SENSITIVE_PROCESSES.has(shell), shell).toBe(true);
    }
    for (const sensitive of ['regedit', 'mmc', 'taskmgr', 'consent'])
      expect(SENSITIVE_PROCESSES.has(sensitive), sensitive).toBe(true);
    expect(SENSITIVE_PROCESSES.has('notepad')).toBe(false);
  });

  it('covers every application the language engine can recognise', () => {
    const catalog = new Set(APP_CATALOG.map((a) => a.name));
    const missing = KNOWN_APP_NAMES.filter((name) => !catalog.has(name));
    // The language engine may know apps the launcher does not (they are then reported as unknown, never guessed).
    expect(missing.sort()).toEqual([]);
  });
});
