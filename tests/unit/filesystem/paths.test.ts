import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AllayaError } from '@allaya/shared';
import {
  PathPolicy,
  checkSegments,
  isProgramFile,
  isRefusal,
  type FolderRoot,
  type RefusalReason,
} from '@allaya/filesystem';
import { fsFixture, type FsFixture } from '../../helpers/fs-fixture';

const winRoots: FolderRoot[] = [
  {
    id: 'documents',
    label: 'Documents',
    path: 'C:\\Users\\Rahim\\Documents',
    aliases: ['ডকুমেন্টস'],
    origin: 'known',
  },
  { id: 'desktop', label: 'Desktop', path: 'C:\\Users\\Rahim\\Desktop', origin: 'known' },
  { id: 'work', label: 'Work', path: 'D:\\Work', origin: 'user' },
];
const win = new PathPolicy({
  roots: () => winRoots,
  platform: 'win32',
  protectedPaths: ['C:\\Users\\Rahim\\AppData\\Roaming\\Allaya'],
});

const refuses = (run: () => unknown, reason: RefusalReason) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AllayaError);
    expect((error as AllayaError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`expected a refusal (${reason}), but it was allowed`);
};

describe('PathPolicy — Windows path rules (checked without touching a disk)', () => {
  it('accepts folder-relative paths in any supported language and separators', () => {
    expect(win.locate('Documents/Reports/a.txt').segments).toEqual(['Reports', 'a.txt']);
    expect(win.locate('documents\\Reports\\a.txt').root.id).toBe('documents');
    expect(win.locate('ডকুমেন্টস/নোট.txt').root.id).toBe('documents');
    expect(win.locate('Documents').segments).toEqual([]);
    expect(win.locate('Work/x').root.id).toBe('work');
  });

  it('accepts absolute paths that lie inside a root, case-insensitively', () => {
    const located = win.locate('c:\\users\\rahim\\documents\\Reports\\a.txt');
    expect(located.root.id).toBe('documents');
    expect(located.segments).toEqual(['Reports', 'a.txt']);
    expect(win.locate('D:/Work/deep/er/file.md').segments).toEqual(['deep', 'er', 'file.md']);
  });

  it('refuses anywhere outside the roots', () => {
    refuses(() => win.locate('C:\\Windows\\System32\\cmd.exe'), 'outside_roots');
    refuses(() => win.locate('C:\\Users\\Rahim\\AppData\\Local\\x'), 'outside_roots');
    refuses(() => win.locate('C:\\Users\\Rahim\\Documents2\\x'), 'outside_roots'); // prefix, not parent
    refuses(() => win.locate('Program Files/x'), 'outside_roots');
    refuses(() => win.locate('C:\\'), 'outside_roots');
    refuses(() => win.locate('E:\\Work\\x'), 'outside_roots'); // other drive, same folder name
  });

  it('refuses ".." however it is written — it is rejected, never normalised', () => {
    refuses(() => win.locate('Documents/../Windows'), 'traversal');
    refuses(() => win.locate('Documents\\..\\..\\Windows\\win.ini'), 'traversal');
    refuses(() => win.locate('C:\\Users\\Rahim\\Documents\\..\\AppData'), 'traversal');
    refuses(() => win.locate('Documents/a/../../b'), 'traversal');
  });

  it('refuses network, device and extended-length paths', () => {
    refuses(() => win.locate('\\\\server\\share\\file.txt'), 'network_path');
    refuses(() => win.locate('//server/share/file.txt'), 'network_path');
    refuses(() => win.locate('\\\\?\\C:\\Windows\\System32'), 'network_path');
    refuses(() => win.locate('\\\\.\\PhysicalDrive0'), 'network_path');
    refuses(() => win.locate('file:///C:/Users/Rahim/Documents/a.txt'), 'invalid_name');
    refuses(() => win.locate('https://example.com/a.txt'), 'invalid_name');
  });

  it('refuses alternate data streams, wildcards and illegal characters', () => {
    refuses(() => win.locate('Documents/report.txt:secret'), 'stream');
    refuses(() => win.locate('Documents/report.txt::$DATA'), 'stream');
    refuses(() => win.locate('C:\\Users\\Rahim\\Documents\\a.txt:hidden.exe'), 'stream');
    refuses(() => win.locate('Documents/*.txt'), 'invalid_name');
    refuses(() => win.locate('Documents/what?.txt'), 'invalid_name');
    refuses(() => win.locate('Documents/a|b'), 'invalid_name');
    refuses(() => win.locate('Documents/a"b'), 'invalid_name');
  });

  it('refuses reserved device names, with or without an extension', () => {
    for (const name of ['CON', 'nul', 'Aux.txt', 'COM1', 'lpt9.log', 'PRN.', 'CONIN$']) {
      expect(() => win.locate(`Documents/${name}`), name).toThrow(AllayaError);
    }
    expect(() => win.locate('Documents/console.txt')).not.toThrow();
    expect(() => win.locate('Documents/COM10.txt')).not.toThrow();
  });

  it('refuses trailing dots/spaces and 8.3 short names', () => {
    refuses(() => win.locate('Documents/notes.txt.'), 'invalid_name');
    refuses(() => win.locate('Documents/notes /a'), 'invalid_name');
    refuses(() => win.locate('Documents/folder./a'), 'invalid_name');
    refuses(() => win.locate('Documents/PROGRA~1'), 'invalid_name');
    refuses(() => win.locate('Documents/USERDA~1/x'), 'invalid_name');
    refuses(() => win.locate('Documents/REPORT~1.DOC'), 'invalid_name');
    expect(() => win.locate('Documents/a~b.txt')).not.toThrow(); // a tilde is not automatically a short name
  });

  it('refuses text-direction tricks in names, but keeps Bengali joiners working', () => {
    refuses(() => win.locate('Documents/invoice\u202Egpj.exe'), 'invalid_name');
    refuses(() => win.locate('Documents/\u2066x\u2069.txt'), 'invalid_name');
    refuses(() => win.locate('Documents/a\u200Fb.txt'), 'invalid_name');
    refuses(() => win.assertName('safe\u202Etxt.exe'), 'invalid_name');
    // ZWNJ / ZWJ occur in ordinary Bengali words (e.g. র‍্যাব, কর্‍মী) and must stay valid.
    expect(() => win.locate('Documents/র\u200D্যাব.txt')).not.toThrow();
    expect(() => win.locate('Documents/ক\u200Cখ.txt')).not.toThrow();
  });

  it('refuses drive-relative and control-character paths, and empty input', () => {
    refuses(() => win.locate('C:foo'), 'invalid_name');
    refuses(() => win.locate('Documents/a\u0000.txt'), 'invalid_name');
    refuses(() => win.locate('Documents/a\nb'), 'invalid_name');
    refuses(() => win.locate('   '), 'invalid_name');
    refuses(() => win.locate('x'.repeat(2000)), 'invalid_name');
  });

  it('refuses an unknown first folder and lists the folders that exist', () => {
    try {
      win.locate('Music/song.mp3');
      throw new Error('allowed');
    } catch (error) {
      expect((error as AllayaError).message).toContain('Documents');
      expect((error as AllayaError).message).toContain('Work');
    }
  });

  it('refuses secret names for reading and writing, wherever they are', () => {
    for (const p of [
      'Documents/.ssh/id_rsa',
      'Documents/project/.env',
      'Documents/project/.env.production',
      'Work/keys/server.pem',
      'Work/backup.kdbx',
      'Documents/id_ed25519',
      'Documents/.aws/credentials',
      'Documents/.npmrc',
      'Documents/service-account-prod.json',
      'Documents/Chrome/User Data/Default/Login Data',
    ]) {
      refuses(() => win.locate(p, 'read'), 'secret');
      refuses(() => win.locate(p, 'write'), 'secret');
    }
    expect(checkSegments(['notes.txt'], 'write')).toBeUndefined();
    expect(checkSegments(['environment.txt'], 'write')).toBeUndefined(); // ".env" must not match by prefix
  });

  it('refuses operating-system-managed names for writing only', () => {
    refuses(() => win.locate('Documents/repo/.git/config', 'write'), 'protected');
    refuses(() => win.locate('Documents/desktop.ini', 'write'), 'protected');
    expect(() => win.locate('Documents/repo/.git/config', 'read')).not.toThrow();
  });

  it('recognises programs, scripts and shortcuts', () => {
    for (const name of [
      'setup.exe',
      'run.BAT',
      'x.ps1',
      'a.lnk',
      'macro.vbs',
      'page.hta',
      'i.reg',
      'x.js',
      'x.msi',
      'x.bat.',
    ]) {
      expect(isProgramFile(name), name).toBe(true);
    }
    for (const name of [
      'notes.txt',
      'photo.jpg',
      'report.docx',
      'data.csv',
      'bat',
      'archive.zip',
    ]) {
      expect(isProgramFile(name), name).toBe(false);
    }
  });

  it('validates new names: one segment, no programs, no secrets', () => {
    expect(win.assertName('report 2026.txt')).toBe('report 2026.txt');
    refuses(() => win.assertName('a/b.txt'), 'invalid_name');
    refuses(() => win.assertName('..'), 'traversal');
    refuses(() => win.assertName(''), 'invalid_name');
    refuses(() => win.assertName('run.bat'), 'program_file');
    refuses(() => win.assertName('CON'), 'reserved_name');
    refuses(() => win.assertName('.env'), 'secret');
    refuses(() => win.assertName('x.txt:s'), 'stream');
  });

  it('decides which folders may become roots', () => {
    const home = 'C:\\Users\\Rahim';
    expect(() => win.assertRootAllowed('D:\\Projects', home)).not.toThrow();
    expect(() => win.assertRootAllowed('C:\\Users\\Rahim\\Music', home)).not.toThrow();
    refuses(() => win.assertRootAllowed('C:\\', home), 'is_root');
    refuses(() => win.assertRootAllowed('D:\\', home), 'is_root');
    refuses(() => win.assertRootAllowed('C:\\Users\\Rahim', home), 'is_root');
    refuses(() => win.assertRootAllowed('C:\\Users', home), 'is_root');
    refuses(() => win.assertRootAllowed('C:\\Windows', home), 'protected');
    refuses(() => win.assertRootAllowed('C:\\Program Files\\Thing', home), 'protected');
    refuses(() => win.assertRootAllowed('C:\\Users\\Rahim\\.ssh', home), 'secret');
    refuses(
      () => win.assertRootAllowed('C:\\Users\\Rahim\\AppData\\Roaming\\Allaya', home),
      'protected',
    );
    refuses(() => win.assertRootAllowed('C:\\Users\\Rahim\\AppData\\Local', home), 'secret'); // AppData
    refuses(() => win.assertRootAllowed('\\\\nas\\share', home), 'network_path');
    refuses(() => win.assertRootAllowed('relative\\folder', home), 'invalid_name');
  });
});

describe('PathPolicy — on a real disk', () => {
  let fx: FsFixture;
  afterEach(() => fx?.cleanup());

  it('resolves inside a root and reports the folder-relative display form', async () => {
    fx = fsFixture();
    fx.write('Documents/Reports/a.txt');
    const resolved = await fx.policy.resolve('Documents/Reports/a.txt', { mode: 'read' });
    expect(resolved.path).toBe(join(fx.documents, 'Reports', 'a.txt'));
    expect(resolved.display).toBe('Documents/Reports/a.txt');
    expect(resolved.isRoot).toBe(false);
    // absolute form, and a path that does not exist yet
    expect(
      (await fx.policy.resolve(join(fx.documents, 'Reports', 'a.txt'), { mode: 'read' })).display,
    ).toBe('Documents/Reports/a.txt');
    expect((await fx.policy.resolve('Documents/new/deeper/x.txt', { mode: 'write' })).path).toBe(
      join(fx.documents, 'new', 'deeper', 'x.txt'),
    );
    expect((await fx.policy.resolve('Documents', { mode: 'read' })).isRoot).toBe(true);
  });

  it('refuses a path outside every root, absolute or not', async () => {
    fx = fsFixture();
    const secret = fx.write('Outside/passwords.txt');
    await expect(fx.policy.resolve(secret, { mode: 'read' })).rejects.toMatchObject({
      details: { reason: 'outside_roots' },
    });
    await expect(
      fx.policy.resolve('Outside/passwords.txt', { mode: 'read' }),
    ).rejects.toMatchObject({ details: { reason: 'outside_roots' } });
    await expect(fx.policy.resolve('/etc/passwd', { mode: 'read' })).rejects.toMatchObject({
      details: { reason: 'outside_roots' },
    });
  });

  it('is not fooled by a symbolic link that points out of the root', async () => {
    fx = fsFixture();
    fx.write('Outside/passwords.txt', 'hunter2');
    symlinkSync(fx.outside, join(fx.documents, 'shortcut'), 'dir');
    symlinkSync(join(fx.outside, 'passwords.txt'), join(fx.documents, 'pw.txt'));

    for (const p of [
      'Documents/shortcut',
      'Documents/shortcut/passwords.txt',
      'Documents/pw.txt',
    ]) {
      await expect(fx.policy.resolve(p, { mode: 'read' }), p).rejects.toMatchObject({
        details: { reason: 'symlink_escape' },
      });
    }
    // writing "through" the link, to a file that does not exist yet
    await expect(
      fx.policy.resolve('Documents/shortcut/new.txt', { mode: 'write' }),
    ).rejects.toMatchObject({ details: { reason: 'symlink_escape' } });
  });

  it('allows a link that stays inside the root, and treats a final link as itself when not following', async () => {
    fx = fsFixture();
    fx.write('Documents/real/a.txt');
    symlinkSync(join(fx.documents, 'real'), join(fx.documents, 'alias'), 'dir');
    symlinkSync(fx.outside, join(fx.documents, 'out-link'), 'dir');

    expect((await fx.policy.resolve('Documents/alias/a.txt', { mode: 'read' })).path).toBe(
      join(fx.documents, 'real', 'a.txt'),
    );
    // Deleting/renaming a link acts on the link, so a link to the outside is a valid *subject* (the target is untouched).
    const asSubject = await fx.policy.resolve('Documents/out-link', {
      mode: 'write',
      follow: false,
    });
    expect(asSubject.path).toBe(join(fx.documents, 'out-link'));
    // ...but reading through it is not.
    await expect(fx.policy.resolve('Documents/out-link', { mode: 'read' })).rejects.toMatchObject({
      details: { reason: 'symlink_escape' },
    });
  });

  it('refuses a dangling link and a link loop', async () => {
    fx = fsFixture();
    symlinkSync(join(fx.base, 'nowhere'), join(fx.documents, 'dangling'));
    symlinkSync(join(fx.documents, 'loop-b'), join(fx.documents, 'loop-a'));
    symlinkSync(join(fx.documents, 'loop-a'), join(fx.documents, 'loop-b'));
    await expect(fx.policy.resolve('Documents/dangling', { mode: 'read' })).rejects.toBeInstanceOf(
      AllayaError,
    );
    await expect(fx.policy.resolve('Documents/loop-a', { mode: 'read' })).rejects.toBeInstanceOf(
      AllayaError,
    );
  });

  it('re-checks secret names on the real location, so a link cannot launder one', async () => {
    fx = fsFixture();
    fx.write('Documents/.ssh/id_rsa', 'PRIVATE');
    symlinkSync(join(fx.documents, '.ssh'), join(fx.documents, 'innocent'), 'dir');
    await expect(
      fx.policy.resolve('Documents/innocent/id_rsa', { mode: 'read' }),
    ).rejects.toMatchObject({ details: { reason: 'secret' } });
  });

  it("never touches Allaya's own data folder, in either direction", async () => {
    fx = fsFixture();
    // A root that would contain the data folder (the whole base directory) must not expose it.
    const wide: FolderRoot = { id: 'wide', label: 'Wide', path: fx.base, origin: 'user' };
    const policy = new PathPolicy({ roots: () => [wide], protectedPaths: [fx.appData] });
    await expect(
      policy.resolve('Wide/Support/Allaya/allaya.sqlite', { mode: 'read' }),
    ).rejects.toMatchObject({ details: { reason: 'protected' } });
    await expect(
      policy.resolve('Wide/Support', { mode: 'write', follow: false }),
    ).rejects.toMatchObject({ details: { reason: 'protected' } });
    expect(() => policy.assertRootAllowed(fx.appData, '/nonexistent-home')).toThrow(AllayaError);
    expect(() => policy.assertRootAllowed(fx.base, '/nonexistent-home')).toThrow(AllayaError);
  });

  it('follows a folder added at runtime immediately', async () => {
    fx = fsFixture();
    const extra = fx.dir('Projects');
    await expect(fx.policy.resolve('Projects/x', { mode: 'read' })).rejects.toBeInstanceOf(
      AllayaError,
    );
    fx.roots.push({ id: 'projects', label: 'Projects', path: extra, origin: 'user' });
    expect((await fx.policy.resolve('Projects/x', { mode: 'read' })).path).toBe(join(extra, 'x'));
  });

  it('reports a missing root as such', async () => {
    fx = fsFixture();
    fx.roots.push({ id: 'gone', label: 'Gone', path: join(fx.base, 'gone'), origin: 'user' });
    expect(
      isRefusal(
        await fx.policy.resolve('Gone/x', { mode: 'read' }).catch((e: unknown) => e),
        'missing',
      ),
    ).toBe(true);
  });

  it('cannot be tricked by a name that merely starts like a root', async () => {
    fx = fsFixture();
    mkdirSync(join(fx.base, 'Documents-old'));
    writeFileSync(join(fx.base, 'Documents-old', 'x.txt'), 'x');
    await expect(
      fx.policy.resolve(join(fx.base, 'Documents-old', 'x.txt'), { mode: 'read' }),
    ).rejects.toMatchObject({ details: { reason: 'outside_roots' } });
  });
});
