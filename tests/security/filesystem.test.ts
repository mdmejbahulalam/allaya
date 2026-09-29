import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AllayaError } from '@allaya/shared';
import { checkSegments, type FileManager } from '@allaya/filesystem';
import { fsFixture, type FsFixture } from '../helpers/fs-fixture';

/**
 * The file tools are driven by text a language model produced, possibly after reading a hostile web page or
 * document. These tests throw hostile paths at every operation and check the two things that matter:
 * nothing outside the allowed folders changes, and every refusal is a clean, typed error.
 */

let fx: FsFixture;
afterEach(() => fx?.cleanup());

/** A hash of every file and folder below `root` (names, kinds and contents). */
function snapshot(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const info = lstatSync(full);
      hash.update(`${full}|${info.isDirectory() ? 'd' : info.isSymbolicLink() ? 'l' : 'f'}|`);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) hash.update(readFileSync(full));
    }
  };
  walk(root);
  return hash.digest('hex');
}

const build = () => {
  fx = fsFixture();
  fx.write('Outside/passwords.txt', 'hunter2');
  fx.write('Outside/deep/notes.txt', 'private');
  fx.write('Support/Allaya/allaya.sqlite', 'DATABASE');
  fx.write('Documents/.ssh/id_rsa', 'PRIVATE KEY');
  fx.write('Documents/.env', 'TOKEN=abc');
  fx.write('Documents/ok.txt', 'fine');
  symlinkSync(fx.outside, join(fx.documents, 'to-outside'), 'dir');
  symlinkSync(join(fx.outside, 'passwords.txt'), join(fx.documents, 'pw-link.txt'));
  symlinkSync(fx.appData, join(fx.desktop, 'to-data'), 'dir');
  return {
    protectedTrees: [fx.outside, fx.appData],
    secretFiles: [join(fx.documents, '.ssh', 'id_rsa'), join(fx.documents, '.env')],
  };
};

const HOSTILE = [
  '../Outside/passwords.txt',
  'Documents/../Outside/passwords.txt',
  'Documents/../../etc/passwd',
  'Documents/./../Outside',
  'Documents//..//Outside',
  '..',
  '../..',
  '/',
  '/etc/passwd',
  '/etc',
  'Outside',
  'Outside/passwords.txt',
  'Documents/to-outside',
  'Documents/to-outside/passwords.txt',
  'Documents/to-outside/deep/notes.txt',
  'Documents/pw-link.txt',
  'Desktop/to-data',
  'Desktop/to-data/allaya.sqlite',
  'Documents/.ssh',
  'Documents/.ssh/id_rsa',
  'Documents/.env',
  '~/.ssh/id_rsa',
  '$HOME/.ssh/id_rsa',
  '%USERPROFILE%\\.ssh\\id_rsa',
  'file:///etc/passwd',
  'https://evil.example/x.txt',
  '\\\\server\\share\\x.txt',
  '//server/share/x.txt',
  'Documents/x\u0000.txt',
  'Documents/‮gnp.txt',
  'Documents/a\nb',
  `Documents/${'a'.repeat(400)}`,
  'x'.repeat(5000),
  '',
  '   ',
  'Documents/../Documents/../..',
  'Documents/%2e%2e/%2e%2e/Outside',
  'Documents/..\\..\\Outside',
];

async function throwEverythingAt(manager: FileManager, path: string) {
  const attempts: Array<() => Promise<unknown>> = [
    () => manager.list(path),
    () => manager.info(path),
    () => manager.readText(path),
    () => manager.search({ query: 'x', folder: path }),
    () => manager.createFolder(path),
    () => manager.writeFile(path, 'PWNED'),
    () => manager.writeFile(path, 'PWNED', { overwrite: true }),
    () => manager.copy(path, 'Documents'),
    () => manager.copy('Documents/ok.txt', path),
    () => manager.copy('Documents/ok.txt', 'Desktop', { newName: path }),
    () => manager.move(path, 'Desktop'),
    () => manager.move('Documents/ok.txt', path),
    () => manager.rename(path, 'renamed.txt'),
    () => manager.rename('Documents/ok.txt', path),
    () => manager.trash(path, { folder: false }),
    () => manager.trash(path, { folder: true }),
    () => manager.open(path),
    () => manager.measure(path),
    () => manager.readBack(path),
  ];
  const failures: unknown[] = [];
  for (const attempt of attempts) {
    try {
      await attempt();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

describe('hostile paths against every file operation', () => {
  it('never change anything outside the allowed folders or touch a secret', async () => {
    const { protectedTrees, secretFiles } = build();
    const before = protectedTrees.map(snapshot);
    const secretsBefore = secretFiles.map((f) => readFileSync(f, 'utf8'));

    for (const path of HOSTILE) {
      await throwEverythingAt(fx.manager, path);
      expect(protectedTrees.map(snapshot), `after ${JSON.stringify(path)}`).toEqual(before);
      expect(secretFiles.map((f) => readFileSync(f, 'utf8'))).toEqual(secretsBefore);
    }
  });

  it('fail with typed errors that never contain a real path or the hostile text verbatim', async () => {
    build();
    for (const path of HOSTILE.filter((p) => p.trim() !== '')) {
      for (const error of await throwEverythingAt(fx.manager, path)) {
        expect(error, JSON.stringify(path)).toBeInstanceOf(AllayaError);
        const message = (error as AllayaError).message;
        expect(message).not.toContain(fx.base);
        expect(message).not.toContain('hunter2');
        expect(message).not.toContain('PRIVATE KEY');
      }
    }
  });

  it('are refused by resolve for the paths that lead outside, whatever the operation', async () => {
    build();
    const mustRefuse = HOSTILE.filter(
      (p) =>
        !p.includes('%2e') &&
        !p.includes('\\') && // a backslash is an ordinary character in a POSIX file name (the Windows rules are tested separately)
        (p.includes('Outside') ||
          p.includes('to-') ||
          p.includes('etc') ||
          p.includes('..') ||
          p.includes('.ssh') ||
          p.startsWith('/') ||
          p.includes('server')),
    );
    for (const path of mustRefuse) {
      for (const mode of ['read', 'write'] as const) {
        await expect(fx.policy.resolve(path, { mode }), `${mode} ${path}`).rejects.toBeInstanceOf(
          AllayaError,
        );
      }
    }
  });
});

/** A small deterministic generator, so a failure can be reproduced from its seed. */
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('generated paths (property test)', () => {
  it('either refuse, or resolve strictly inside an allowed folder and outside Allaya data', async () => {
    build();
    const next = rng(20260929);
    const tokens = [
      'Documents',
      'Desktop',
      'Outside',
      'to-outside',
      'pw-link.txt',
      'to-data',
      '..',
      '.',
      '...',
      '/',
      '\\',
      '//',
      'ok.txt',
      '.ssh',
      '.env',
      'id_rsa',
      'Support',
      'Allaya',
      'x',
      '%2e%2e',
      '\u0000',
      ' ',
      'ডকুমেন্টস',
      'ডেস্কটপ',
      fx.outside,
      fx.appData,
      fx.documents,
      'deep',
      'notes.txt',
      'new.txt',
      ':',
      '*',
      '~',
    ];
    const documents = fx.documents;
    const desktop = fx.desktop;
    let allowed = 0;
    let refused = 0;
    for (let i = 0; i < 3000; i += 1) {
      const length = 1 + Math.floor(next() * 5);
      const path = Array.from({ length }, () => tokens[Math.floor(next() * tokens.length)]!).join(
        next() < 0.8 ? '/' : '',
      );
      for (const mode of ['read', 'write'] as const) {
        for (const follow of [true, false]) {
          const outcome = await fx.policy.resolve(path, { mode, follow }).then(
            (resolved) => ({ resolved }),
            (error: unknown) => ({ error }),
          );
          if ('error' in outcome) {
            refused += 1;
            expect(outcome.error, JSON.stringify(path)).toBeInstanceOf(AllayaError);
            continue;
          }
          allowed += 1;
          const { resolved } = outcome;
          const shown = `${JSON.stringify(path)} → ${resolved.path}`;
          expect(
            [documents, desktop].some((root) => fx.policy.isInside(root, resolved.path)),
            shown,
          ).toBe(true);
          expect(fx.policy.isInside(fx.appData, resolved.path), shown).toBe(false);
          expect(fx.policy.isInside(fx.outside, resolved.path), shown).toBe(false);
          expect(checkSegments(resolved.segments, mode), shown).toBeUndefined();
        }
      }
    }
    // The generator must actually exercise both outcomes, or the property proves nothing.
    expect(allowed).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(1000);
  });
});
