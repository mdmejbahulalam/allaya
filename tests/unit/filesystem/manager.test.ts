import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AllayaError } from '@allaya/shared';
import { FileManager, MemoryJournal, decodeText } from '@allaya/filesystem';
import type { JournalStore } from '@allaya/filesystem';
import { fsFixture, type FsFixture } from '../../helpers/fs-fixture';

let fx: FsFixture;
afterEach(() => fx?.cleanup());

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => 'allowed',
    (error: unknown) => {
      if (!(error instanceof AllayaError)) return `other:${String(error)}`;
      const why = error.details?.['reason'];
      return typeof why === 'string' ? why : error.code;
    },
  );

describe('FileManager — listing and info', () => {
  it('lists folders first, in natural order, and hides dot-files unless asked', async () => {
    fx = fsFixture();
    fx.write('Documents/file10.txt');
    fx.write('Documents/file2.txt');
    fx.dir('Documents/Zeta');
    fx.dir('Documents/alpha');
    fx.write('Documents/.hidden');
    const listing = await fx.manager.list('Documents');
    expect(listing.entries.map((e) => e.name)).toEqual([
      'alpha',
      'Zeta',
      'file2.txt',
      'file10.txt',
    ]);
    expect(listing.path).toBe('Documents');
    const all = await fx.manager.list('Documents', { showHidden: true });
    expect(all.entries.map((e) => e.name)).toContain('.hidden');
  });

  it('omits entries whose names mark them as secrets, and says how many', async () => {
    fx = fsFixture();
    fx.write('Documents/notes.txt');
    fx.write('Documents/.env');
    fx.write('Documents/server.pem');
    fx.dir('Documents/.ssh');
    const listing = await fx.manager.list('Documents', { showHidden: true });
    expect(listing.entries.map((e) => e.name)).toEqual(['notes.txt']);
    expect(listing.omitted).toBe(3);
  });

  it('reports links as links and never follows them', async () => {
    fx = fsFixture();
    symlinkSync(fx.outside, join(fx.documents, 'out'), 'dir');
    const listing = await fx.manager.list('Documents');
    expect(listing.entries).toEqual([
      expect.objectContaining({ name: 'out', kind: 'link', size: 0 }),
    ]);
    expect(await reason(fx.manager.list('Documents/out'))).toBe('symlink_escape');
  });

  it('truncates long listings and says so', async () => {
    fx = fsFixture();
    for (let i = 0; i < 12; i += 1) fx.write(`Documents/f${String(i).padStart(2, '0')}.txt`);
    const listing = await fx.manager.list('Documents', { limit: 5 });
    expect(listing.entries).toHaveLength(5);
    expect(listing.total).toBe(12);
    expect(listing.truncated).toBe(true);
  });

  it('gives file information, and refuses outside the roots', async () => {
    fx = fsFixture();
    fx.write('Documents/report.pdf', 'x'.repeat(1234));
    const info = await fx.manager.info('Documents/report.pdf');
    expect(info).toMatchObject({
      name: 'report.pdf',
      kind: 'file',
      size: 1234,
      extension: 'pdf',
      path: 'Documents/report.pdf',
    });
    expect(await reason(fx.manager.info(fx.write('Outside/x.txt')))).toBe('outside_roots');
    expect(await reason(fx.manager.list('Documents/missing'))).toBe('NOT_FOUND');
  });
});

describe('FileManager — reading', () => {
  it('reads UTF-8 text including Bengali', async () => {
    fx = fsFixture();
    fx.write('Documents/নোট.txt', 'আমার নোট: বাজার করতে হবে\nline two');
    const result = await fx.manager.readText('Documents/নোট.txt');
    expect(result.text).toBe('আমার নোট: বাজার করতে হবে\nline two');
    expect(result.truncated).toBe(false);
  });

  it('cuts at the requested number of characters without splitting one', async () => {
    fx = fsFixture();
    fx.write('Documents/long.txt', 'আ'.repeat(500));
    const result = await fx.manager.readText('Documents/long.txt', 100);
    expect(Array.from(result.text)).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('�');
  });

  it('only reads the start of a huge file', async () => {
    fx = fsFixture();
    fx.write('Documents/huge.txt', 'a'.repeat(6_000_000));
    const result = await fx.manager.readText('Documents/huge.txt', 1000);
    expect(result.characters).toBe(1000);
    expect(result.bytes).toBe(6_000_000);
    expect(result.truncated).toBe(true);
  });

  it('honours UTF-8 and UTF-16 byte-order marks (Notepad writes both)', async () => {
    fx = fsFixture();
    fx.write(
      'Documents/bom.txt',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('হ্যালো')]),
    );
    fx.write(
      'Documents/u16.txt',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi there বাংলা', 'utf16le')]),
    );
    expect((await fx.manager.readText('Documents/bom.txt')).text).toBe('হ্যালো');
    expect((await fx.manager.readText('Documents/u16.txt')).text).toBe('hi there বাংলা');
  });

  it('refuses binary files, folders, secrets and anything outside', async () => {
    fx = fsFixture();
    fx.write(
      'Documents/photo.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0xff, 0xfe, 0x00]),
    );
    fx.write(
      'Documents/blob.bin',
      Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 37) % 256)),
    );
    fx.write('Documents/.env', 'API_KEY=abc');
    fx.dir('Documents/sub');
    expect(await reason(fx.manager.readText('Documents/photo.png'))).toBe('not_text');
    expect(await reason(fx.manager.readText('Documents/blob.bin'))).toBe('not_text');
    expect(await reason(fx.manager.readText('Documents/.env'))).toBe('secret');
    expect(await reason(fx.manager.readText('Documents/sub'))).toBe('not_file');
    expect(await reason(fx.manager.readText(fx.write('Outside/x.txt')))).toBe('outside_roots');
  });

  it('decodeText recognises text and not-text', () => {
    expect(decodeText(Buffer.from('plain'), false)).toBe('plain');
    expect(decodeText(Buffer.from([0x50, 0x00, 0x4b]), false)).toBeUndefined();
    expect(decodeText(Buffer.from(Array.from({ length: 200 }, () => 0xff)), false)).toBeUndefined();
  });
});

describe('FileManager — searching', () => {
  it('finds by every word of the name, case-insensitively, across roots', async () => {
    fx = fsFixture();
    fx.write('Documents/Reports/Sales Report 2026.xlsx');
    fx.write('Desktop/sales-report-draft.txt');
    fx.write('Documents/other.txt');
    const result = await fx.manager.search({ query: 'REPORT sales' });
    expect(result.hits.map((h) => h.path).sort()).toEqual([
      'Desktop/sales-report-draft.txt',
      'Documents/Reports/Sales Report 2026.xlsx',
    ]);
  });

  it('filters by extension and kind, and can search one folder', async () => {
    fx = fsFixture();
    fx.write('Documents/a.pdf');
    fx.write('Documents/b.txt');
    fx.write('Desktop/c.pdf');
    fx.dir('Documents/pdfs');
    expect((await fx.manager.search({ query: '', extension: '.pdf' })).hits).toHaveLength(2);
    expect(
      (await fx.manager.search({ query: '', extension: 'pdf', folder: 'Desktop' })).hits.map(
        (h) => h.name,
      ),
    ).toEqual(['c.pdf']);
    expect(
      (await fx.manager.search({ query: 'pdf', kind: 'directory' })).hits.map((h) => h.name),
    ).toEqual(['pdfs']);
  });

  it('finds Bengali names, however they are normalised', async () => {
    fx = fsFixture();
    fx.write('Documents/আমার ছবি.jpg');
    const result = await fx.manager.search({ query: 'ছবি' });
    expect(result.hits.map((h) => h.name)).toEqual(['আমার ছবি.jpg']);
  });

  it('skips generated and secret folders, secret files, and does not follow links', async () => {
    fx = fsFixture();
    fx.write('Documents/proj/node_modules/pkg/needle.js');
    fx.write('Documents/proj/.git/needle');
    fx.write('Documents/.ssh/needle_rsa');
    fx.write('Documents/needle.pem');
    fx.write('Outside/needle-outside.txt');
    symlinkSync(fx.outside, join(fx.documents, 'link-out'), 'dir');
    fx.write('Documents/visible/needle.txt');
    const result = await fx.manager.search({ query: 'needle' });
    expect(result.hits.map((h) => h.path)).toEqual(['Documents/visible/needle.txt']);
  });

  it('stops at its limits and says the search may be incomplete', async () => {
    fx = fsFixture({ limits: { searchMaxEntries: 20, searchMaxDepth: 2 } });
    for (let i = 0; i < 40; i += 1) fx.write(`Documents/file${i}.txt`);
    expect((await fx.manager.search({ query: 'nomatch' })).truncated).toBe(true);
    fx.dir('Desktop/a/b/c/d');
    fx.write('Desktop/a/b/c/d/deep.txt');
    const deep = await fx.manager.search({ query: 'deep', folder: 'Desktop' });
    expect(deep.hits).toHaveLength(0);
    expect(deep.truncated).toBe(true);
  });

  it('honours cancellation and requires something to search for', async () => {
    fx = fsFixture();
    fx.write('Documents/a.txt');
    const controller = new AbortController();
    controller.abort(new AllayaError('stop', { code: 'CANCELLED' }));
    await expect(
      fx.manager.search({ query: 'a', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(fx.manager.search({ query: '  ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('FileManager — creating folders and files', () => {
  it('creates nested folders, is idempotent, and refuses to shadow a file', async () => {
    fx = fsFixture();
    const created = await fx.manager.createFolder('Documents/Projects/2026/Reports');
    expect(created.created).toBe(true);
    expect(statSync(join(fx.documents, 'Projects', '2026', 'Reports')).isDirectory()).toBe(true);
    expect((await fx.manager.createFolder('Documents/Projects/2026/Reports')).created).toBe(false);
    fx.write('Documents/afile');
    expect(await reason(fx.manager.createFolder('Documents/afile'))).toBe('exists');
  });

  it('creates a text file that reads back exactly (Bengali included), without a BOM', async () => {
    fx = fsFixture();
    const text = 'আজকের কাজ:\n১. বাজার\n2. Email Rahim\r\n';
    const result = await fx.manager.writeFile('Documents/todo.txt', text);
    expect(result).toMatchObject({ created: true, overwrote: false, path: 'Documents/todo.txt' });
    const bytes = readFileSync(join(fx.documents, 'todo.txt'));
    expect(bytes.equals(Buffer.from(text, 'utf8'))).toBe(true);
    expect(bytes[0]).not.toBe(0xef);
  });

  it('never replaces a file unless asked, and leaves it untouched when refused', async () => {
    fx = fsFixture();
    fx.write('Documents/keep.txt', 'original');
    expect(await reason(fx.manager.writeFile('Documents/keep.txt', 'new'))).toBe('exists');
    expect(readFileSync(join(fx.documents, 'keep.txt'), 'utf8')).toBe('original');
  });

  it('replaces on request, keeping the previous version, and leaves no temp files', async () => {
    fx = fsFixture();
    fx.write('Documents/doc.txt', 'version one');
    const result = await fx.manager.writeFile('Documents/doc.txt', 'version two', {
      overwrite: true,
    });
    expect(result).toMatchObject({ created: false, overwrote: true });
    expect(readFileSync(join(fx.documents, 'doc.txt'), 'utf8')).toBe('version two');
    expect(readdirSync(fx.documents)).toEqual(['doc.txt']);
    const entry = fx.journal.get(result.actionId!)!;
    expect(entry).toMatchObject({ kind: 'overwrite', undoable: true });
    expect(await fx.trash.has((entry.data as { backupId: string }).backupId)).toBe(true);
  });

  it('refuses programs, scripts and shortcuts as new files, however they are dressed', async () => {
    fx = fsFixture();
    for (const name of [
      'run.bat',
      'x.PS1',
      'evil.exe',
      'link.lnk',
      'a.vbs',
      'a.js',
      'page.hta',
      'x.reg',
    ]) {
      expect(await reason(fx.manager.writeFile(`Desktop/${name}`, 'echo hi')), name).toBe(
        'program_file',
      );
    }
    // a trailing dot is ignored by Windows, so "run.bat." is still a script
    expect(await reason(fx.manager.writeFile('Desktop/run.bat.', 'x'))).toBe('program_file');
    expect(readdirSync(fx.desktop)).toEqual([]);
  });

  it('refuses secrets, protected names, missing folders, oversized text and folders', async () => {
    fx = fsFixture({ limits: { maxWriteBytes: 1000 } });
    fx.dir('Documents/repo/.git');
    expect(await reason(fx.manager.writeFile('Documents/.env', 'KEY=1'))).toBe('secret');
    expect(await reason(fx.manager.writeFile('Documents/id_rsa', 'KEY'))).toBe('secret');
    expect(await reason(fx.manager.writeFile('Documents/repo/.git/config', 'x'))).toBe('protected');
    expect(await reason(fx.manager.writeFile('Documents/nofolder/x.txt', 'x'))).toBe('missing');
    expect(await reason(fx.manager.writeFile('Documents/big.txt', 'x'.repeat(2000)))).toBe(
      'too_large',
    );
    expect(await reason(fx.manager.writeFile('Documents', 'x'))).toBe('is_root');
    expect(existsSync(join(fx.documents, 'big.txt'))).toBe(false);
  });

  it('does not write through a link that already exists at the target', async () => {
    fx = fsFixture();
    const victim = fx.write('Outside/victim.txt', 'precious');
    symlinkSync(victim, join(fx.documents, 'trap.txt'));
    expect(await reason(fx.manager.writeFile('Documents/trap.txt', 'overwritten'))).not.toBe(
      'allowed',
    );
    expect(
      await reason(fx.manager.writeFile('Documents/trap.txt', 'overwritten', { overwrite: true })),
    ).not.toBe('allowed');
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });
});

describe('FileManager — copying', () => {
  it('copies a file and never overwrites', async () => {
    fx = fsFixture();
    fx.write('Documents/a.txt', 'A');
    fx.dir('Desktop/Backup');
    const result = await fx.manager.copy('Documents/a.txt', 'Desktop/Backup');
    expect(result).toMatchObject({
      path: 'Desktop/Backup/a.txt',
      kind: 'file',
      files: 1,
      bytes: 1,
    });
    expect(readFileSync(join(fx.desktop, 'Backup', 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(fx.documents, 'a.txt'), 'utf8')).toBe('A');
    writeFileSync(join(fx.desktop, 'Backup', 'a.txt'), 'changed');
    expect(await reason(fx.manager.copy('Documents/a.txt', 'Desktop/Backup'))).toBe('exists');
    expect(readFileSync(join(fx.desktop, 'Backup', 'a.txt'), 'utf8')).toBe('changed');
    const renamed = await fx.manager.copy('Documents/a.txt', 'Desktop/Backup', {
      newName: 'a-copy.txt',
    });
    expect(renamed.path).toBe('Desktop/Backup/a-copy.txt');
  });

  it('copies a folder tree, skipping links and secret files, and reports what it skipped', async () => {
    fx = fsFixture();
    fx.write('Documents/proj/src/main.ts', 'code');
    fx.write('Documents/proj/README.md', 'read me');
    fx.write('Documents/proj/.env', 'SECRET=1');
    fx.dir('Documents/proj/empty');
    symlinkSync(fx.outside, join(fx.documents, 'proj', 'escape'), 'dir');
    const result = await fx.manager.copy('Documents/proj', 'Desktop');
    expect(result).toMatchObject({
      kind: 'directory',
      files: 2,
      folders: 2,
      skippedLinks: 1,
      skippedSecrets: 1,
    });
    const copied = join(fx.desktop, 'proj');
    expect(readFileSync(join(copied, 'src', 'main.ts'), 'utf8')).toBe('code');
    expect(existsSync(join(copied, '.env'))).toBe(false);
    expect(existsSync(join(copied, 'escape'))).toBe(false);
    expect(statSync(join(copied, 'empty')).isDirectory()).toBe(true);
  });

  it('refuses a too-large folder before writing anything', async () => {
    fx = fsFixture({ limits: { copyMaxEntries: 10 } });
    for (let i = 0; i < 30; i += 1) fx.write(`Documents/big/f${i}.txt`);
    expect(await reason(fx.manager.copy('Documents/big', 'Desktop'))).toBe('too_large');
    expect(existsSync(join(fx.desktop, 'big'))).toBe(false);
    const bytes = fsFixture({ limits: { copyMaxBytes: 100 } });
    bytes.write('Documents/blob.txt', 'x'.repeat(500));
    expect(await reason(bytes.manager.copy('Documents/blob.txt', 'Desktop'))).toBe('too_large');
    bytes.cleanup();
  });

  it('refuses copying a folder into itself, into a file, and to a missing folder', async () => {
    fx = fsFixture();
    fx.write('Documents/proj/a.txt');
    fx.write('Documents/afile.txt');
    expect(await reason(fx.manager.copy('Documents/proj', 'Documents/proj'))).toBe('exists');
    fx.dir('Documents/proj/inner');
    expect(await reason(fx.manager.copy('Documents/proj', 'Documents/proj/inner'))).toBe('exists');
    expect(await reason(fx.manager.copy('Documents/proj/a.txt', 'Documents/afile.txt'))).toBe(
      'not_directory',
    );
    expect(await reason(fx.manager.copy('Documents/proj/a.txt', 'Desktop/nope'))).toBe('NOT_FOUND');
  });

  it('refuses sources and destinations outside the roots, secrets and program names', async () => {
    fx = fsFixture();
    const outsideFile = fx.write('Outside/x.txt');
    fx.write('Documents/.env');
    fx.write('Documents/setup.exe');
    fx.write('Documents/ok.txt');
    expect(await reason(fx.manager.copy(outsideFile, 'Desktop'))).toBe('outside_roots');
    expect(await reason(fx.manager.copy('Documents/ok.txt', fx.outside))).toBe('outside_roots');
    expect(await reason(fx.manager.copy('Documents/.env', 'Desktop'))).toBe('secret');
    expect(await reason(fx.manager.copy('Documents/setup.exe', 'Desktop'))).toBe('program_file');
    expect(
      await reason(fx.manager.copy('Documents/ok.txt', 'Desktop', { newName: 'ok.bat' })),
    ).toBe('program_file');
    expect(readdirSync(fx.desktop)).toEqual([]);
    expect(readdirSync(fx.outside)).toEqual(['x.txt']);
  });
});

describe('FileManager — moving and renaming', () => {
  it('moves a file, never overwrites, and refuses the roots themselves', async () => {
    fx = fsFixture();
    fx.write('Documents/a.txt', 'A');
    fx.write('Desktop/a.txt', 'other');
    expect(await reason(fx.manager.move('Documents/a.txt', 'Desktop'))).toBe('exists');
    expect(readFileSync(join(fx.desktop, 'a.txt'), 'utf8')).toBe('other');
    const moved = await fx.manager.move('Documents/a.txt', 'Desktop', { newName: 'b.txt' });
    expect(moved).toMatchObject({
      from: 'Documents/a.txt',
      path: 'Desktop/b.txt',
      crossDrive: false,
    });
    expect(existsSync(join(fx.documents, 'a.txt'))).toBe(false);
    expect(readFileSync(join(fx.desktop, 'b.txt'), 'utf8')).toBe('A');
    expect(await reason(fx.manager.move('Documents', 'Desktop'))).toBe('is_root');
  });

  it('moves a folder with its contents and refuses moving it into itself', async () => {
    fx = fsFixture();
    fx.write('Documents/proj/deep/a.txt', 'A');
    await fx.manager.move('Documents/proj', 'Desktop');
    expect(readFileSync(join(fx.desktop, 'proj', 'deep', 'a.txt'), 'utf8')).toBe('A');
    expect(await reason(fx.manager.move('Desktop/proj', 'Desktop/proj/deep'))).toBe('exists');
  });

  it('moves a link as a link — its target is never touched', async () => {
    fx = fsFixture();
    const target = fx.write('Outside/target.txt', 'T');
    symlinkSync(target, join(fx.documents, 'ln.txt'));
    await fx.manager.move('Documents/ln.txt', 'Desktop');
    expect(lstatSync(join(fx.desktop, 'ln.txt')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('T');
  });

  it('renames in place, and a new name is only a name', async () => {
    fx = fsFixture();
    fx.write('Documents/old.txt', 'x');
    fx.write('Documents/taken.txt', 'y');
    const result = await fx.manager.rename('Documents/old.txt', 'new.txt');
    expect(result).toMatchObject({ from: 'Documents/old.txt', path: 'Documents/new.txt' });
    expect(await reason(fx.manager.rename('Documents/new.txt', 'taken.txt'))).toBe('exists');
    expect(await reason(fx.manager.rename('Documents/new.txt', '../evil.txt'))).toBe(
      'invalid_name',
    );
    expect(await reason(fx.manager.rename('Documents/new.txt', 'sub/x.txt'))).toBe('invalid_name');
    expect(await reason(fx.manager.rename('Documents/new.txt', 'new.txt'))).toBe('exists');
    expect(await reason(fx.manager.rename('Documents/new.txt', 'run.cmd'))).toBe('program_file');
    expect(await reason(fx.manager.rename('Documents', 'Docs'))).toBe('is_root');
    expect(readFileSync(join(fx.documents, 'taken.txt'), 'utf8')).toBe('y');
  });
});

describe('FileManager — deleting is only ever moving to the trash', () => {
  it('trashes a file, proves it is gone, and can restore it', async () => {
    fx = fsFixture();
    fx.write('Documents/gone.txt', 'bye');
    const result = await fx.manager.trash('Documents/gone.txt', { folder: false });
    expect(result).toMatchObject({ kind: 'file', items: 1, restorable: true });
    expect(existsSync(join(fx.documents, 'gone.txt'))).toBe(false);
    expect(readdirSync(join(fx.appData, 'trash'))).toHaveLength(1); // it is in the trash, not deleted
    const undone = await fx.manager.undo(result.actionId);
    expect(undone.outcome).toContain('Restored');
    expect(readFileSync(join(fx.documents, 'gone.txt'), 'utf8')).toBe('bye');
  });

  it('keeps files and folders apart: a file tool cannot take a folder, and vice versa', async () => {
    fx = fsFixture();
    fx.write('Documents/dir/a.txt');
    fx.write('Documents/f.txt');
    expect(await reason(fx.manager.trash('Documents/dir', { folder: false }))).toBe('not_file');
    expect(await reason(fx.manager.trash('Documents/f.txt', { folder: true }))).toBe(
      'not_directory',
    );
    expect(existsSync(join(fx.documents, 'dir', 'a.txt'))).toBe(true);
    expect(existsSync(join(fx.documents, 'f.txt'))).toBe(true);
  });

  it('trashes a whole folder and counts what was in it', async () => {
    fx = fsFixture();
    fx.write('Documents/dir/a.txt');
    fx.write('Documents/dir/sub/b.txt');
    const result = await fx.manager.trash('Documents/dir', { folder: true });
    expect(result.items).toBe(4); // dir, a.txt, sub, b.txt
    expect(existsSync(join(fx.documents, 'dir'))).toBe(false);
    await fx.manager.undo(result.actionId);
    expect(readFileSync(join(fx.documents, 'dir', 'sub', 'b.txt'), 'utf8')).toBe('hello');
  });

  it('refuses to delete a root, anything outside, and secrets', async () => {
    fx = fsFixture();
    const outsideFile = fx.write('Outside/x.txt');
    fx.write('Documents/.ssh/id_rsa');
    expect(await reason(fx.manager.trash('Documents', { folder: true }))).toBe('is_root');
    expect(await reason(fx.manager.trash('Desktop', { folder: true }))).toBe('is_root');
    expect(await reason(fx.manager.trash(outsideFile, { folder: false }))).toBe('outside_roots');
    expect(await reason(fx.manager.trash('Documents/.ssh', { folder: true }))).toBe('secret');
    expect(existsSync(outsideFile)).toBe(true);
  });

  it('deleting a link removes the link, never its target', async () => {
    fx = fsFixture();
    const target = fx.write('Outside/keep.txt', 'K');
    symlinkSync(target, join(fx.documents, 'ln.txt'));
    symlinkSync(fx.outside, join(fx.documents, 'dirlink'), 'dir');
    await fx.manager.trash('Documents/ln.txt', { folder: false });
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(fx.documents, 'ln.txt'))).toBe(false);
    // a link to a folder is not a folder to delete recursively
    expect(await reason(fx.manager.trash('Documents/dirlink', { folder: true }))).toBe(
      'not_directory',
    );
    expect(readdirSync(fx.outside)).toEqual(['keep.txt']);
  });

  it('with a trash Allaya cannot restore from (the Recycle Bin), the action is recorded as not undoable', async () => {
    fx = fsFixture();
    const bin: string[] = [];
    const manager = new FileManager({
      policy: fx.policy,
      backups: fx.trash,
      journal: new MemoryJournal(),
      trash: {
        name: 'recycle-bin',
        restorable: false,
        trash: (p) => (bin.push(p), Promise.resolve({})),
      },
    });
    fx.write('Documents/x.txt');
    // the fake bin does not move anything, so the verification (it is gone) must fail loudly
    await expect(manager.trash('Documents/x.txt', { folder: false })).rejects.toMatchObject({
      code: 'VERIFICATION_FAILED',
    });
    const real = new FileManager({
      policy: fx.policy,
      backups: fx.trash,
      journal: new MemoryJournal(),
      trash: {
        name: 'recycle-bin',
        restorable: false,
        trash: async (p) => {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(p);
          return {};
        },
      },
    });
    const result = await real.trash('Documents/x.txt', { folder: false });
    expect(result.restorable).toBe(false);
    const entry = real.journal.get(result.actionId!)!;
    expect(entry.undoable).toBe(false);
    expect(entry.note).toContain('Recycle Bin');
    await expect(real.undo(result.actionId)).rejects.toMatchObject({
      details: { reason: 'not_undoable' },
    });
  });
});

describe('FileManager — undo', () => {
  it('undoes the most recent change by default, and only once', async () => {
    fx = fsFixture();
    await fx.manager.writeFile('Documents/a.txt', 'A');
    await fx.manager.writeFile('Documents/b.txt', 'B');
    const first = await fx.manager.undo();
    expect(first.label).toBe('Documents/b.txt');
    expect(existsSync(join(fx.documents, 'b.txt'))).toBe(false);
    const second = await fx.manager.undo();
    expect(second.label).toBe('Documents/a.txt');
    await expect(fx.manager.undo()).rejects.toMatchObject({ details: { reason: 'not_undoable' } });
    await expect(fx.manager.undo(first.actionId)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('will not remove a file the user changed after Allaya created it', async () => {
    fx = fsFixture();
    const made = await fx.manager.writeFile('Documents/notes.txt', 'mine');
    writeFileSync(join(fx.documents, 'notes.txt'), 'mine, plus the user added a lot more');
    expect(await reason(fx.manager.undo(made.actionId))).toBe('changed');
    expect(readFileSync(join(fx.documents, 'notes.txt'), 'utf8')).toContain('user added');
    // touching only the timestamp also counts as a change
    const other = await fx.manager.writeFile('Documents/other.txt', 'x');
    utimesSync(join(fx.documents, 'other.txt'), new Date(), new Date(Date.now() + 60_000));
    expect(await reason(fx.manager.undo(other.actionId))).toBe('changed');
    expect(existsSync(join(fx.documents, 'other.txt'))).toBe(true);
  });

  it('restores the previous version of a replaced file, and keeps the replacement recoverable', async () => {
    fx = fsFixture();
    fx.write('Documents/doc.txt', 'version one');
    const replaced = await fx.manager.writeFile('Documents/doc.txt', 'version two', {
      overwrite: true,
    });
    const undone = await fx.manager.undo(replaced.actionId);
    expect(undone.outcome).toContain('previous version');
    expect(readFileSync(join(fx.documents, 'doc.txt'), 'utf8')).toBe('version one');
    // version two went to the trash rather than being destroyed
    expect(readdirSync(join(fx.appData, 'trash')).length).toBeGreaterThan(0);
  });

  it('refuses to undo a replacement that was edited afterwards', async () => {
    fx = fsFixture();
    fx.write('Documents/doc.txt', 'one');
    const replaced = await fx.manager.writeFile('Documents/doc.txt', 'two', { overwrite: true });
    writeFileSync(join(fx.documents, 'doc.txt'), 'two + edits');
    expect(await reason(fx.manager.undo(replaced.actionId))).toBe('changed');
    expect(readFileSync(join(fx.documents, 'doc.txt'), 'utf8')).toBe('two + edits');
  });

  it('moves a file back, unless something new is in its place', async () => {
    fx = fsFixture();
    fx.write('Documents/a.txt', 'A');
    const moved = await fx.manager.move('Documents/a.txt', 'Desktop');
    fx.write('Documents/a.txt', 'someone made a new one');
    expect(await reason(fx.manager.undo(moved.actionId))).toBe('exists');
    expect(existsSync(join(fx.desktop, 'a.txt'))).toBe(true);
    const moved2 = await fx.manager
      .move('Desktop/a.txt', 'Desktop', { newName: 'renamed.txt' })
      .catch(() => undefined);
    expect(moved2).toBeDefined();
    fx.write('Documents/b.txt', 'B');
    const renamed = await fx.manager.rename('Documents/b.txt', 'c.txt');
    await fx.manager.undo(renamed.actionId);
    expect(readFileSync(join(fx.documents, 'b.txt'), 'utf8')).toBe('B');
  });

  it('removes a copy only while it is unchanged', async () => {
    fx = fsFixture();
    fx.write('Documents/proj/a.txt', 'A');
    const copy = await fx.manager.copy('Documents/proj', 'Desktop');
    const single = await fx.manager.copy('Documents/proj/a.txt', 'Desktop');
    writeFileSync(join(fx.desktop, 'proj', 'a.txt'), 'edited AAAA');
    expect(await reason(fx.manager.undo(copy.actionId))).toBe('changed');
    expect(existsSync(join(fx.desktop, 'proj'))).toBe(true);
    await fx.manager.undo(single.actionId);
    expect(existsSync(join(fx.desktop, 'a.txt'))).toBe(false);
    expect(existsSync(join(fx.documents, 'proj', 'a.txt'))).toBe(true); // the original is never touched
  });

  it('removes folders it created only while they are still empty', async () => {
    fx = fsFixture();
    const made = await fx.manager.createFolder('Documents/a/b/c');
    await fx.manager.undo(made.actionId);
    expect(existsSync(join(fx.documents, 'a'))).toBe(false);
    const again = await fx.manager.createFolder('Documents/x/y');
    fx.write('Documents/x/y/keep.txt');
    expect(await reason(fx.manager.undo(again.actionId))).toBe('changed');
    expect(existsSync(join(fx.documents, 'x', 'y', 'keep.txt'))).toBe(true);
    // pre-existing folders are not removed
    fx.dir('Documents/pre');
    const partial = await fx.manager.createFolder('Documents/pre/new');
    await fx.manager.undo(partial.actionId);
    expect(existsSync(join(fx.documents, 'pre'))).toBe(true);
    expect(existsSync(join(fx.documents, 'pre', 'new'))).toBe(false);
  });

  it('re-checks the roots at undo time: a journal entry cannot reach outside them', async () => {
    fx = fsFixture();
    const victim = fx.write('Outside/victim.txt', 'V');
    const stat = statSync(victim);
    fx.journal.add({
      id: 'forged',
      createdAt: Date.now(),
      kind: 'create_file',
      label: 'Documents/forged',
      undoable: true,
      data: {
        type: 'create_file',
        path: victim,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
      },
    });
    expect(await reason(fx.manager.undo('forged'))).toBe('outside_roots');
    expect(existsSync(victim)).toBe(true);
  });
});

describe('FileManager — when the undo journal cannot be written', () => {
  it('the action still succeeds (it already happened), is reported, and simply cannot be undone', async () => {
    fx = fsFixture();
    const warnings: string[] = [];
    const broken: JournalStore = {
      add: () => {
        throw new Error('database is locked');
      },
      get: () => undefined,
      list: () => [],
      markUndone: () => undefined,
    };
    const manager = new FileManager({
      policy: fx.policy,
      trash: fx.trash,
      backups: fx.trash,
      journal: broken,
      warn: (message) => warnings.push(message),
    });
    const result = await manager.writeFile('Documents/a.txt', 'A');
    expect(result).toMatchObject({ created: true, bytes: 1 });
    expect(result.actionId).toBeUndefined();
    expect(readFileSync(join(fx.documents, 'a.txt'), 'utf8')).toBe('A');
    expect(warnings).toEqual(['Could not record a file action for undo']);
    const trashed = await manager.trash('Documents/a.txt', { folder: false });
    expect(trashed.actionId).toBeUndefined();
    expect(existsSync(join(fx.documents, 'a.txt'))).toBe(false);
  });
});

describe('FileManager — opening', () => {
  it('opens documents through the host, and refuses programs, folders and missing files', async () => {
    fx = fsFixture();
    fx.write('Documents/report.docx', 'x');
    fx.write('Documents/setup.exe', 'x');
    fx.write('Documents/shortcut.lnk', 'x');
    fx.dir('Documents/dir');
    await fx.manager.open('Documents/report.docx');
    expect(fx.opened).toEqual([join(fx.documents, 'report.docx')]);
    expect(await reason(fx.manager.open('Documents/setup.exe'))).toBe('program_file');
    expect(await reason(fx.manager.open('Documents/shortcut.lnk'))).toBe('program_file');
    expect(await reason(fx.manager.open('Documents/dir'))).toBe('not_file');
    expect(await reason(fx.manager.open('Documents/missing.txt'))).toBe('NOT_FOUND');
    expect(await reason(fx.manager.open(fx.write('Outside/x.txt')))).toBe('outside_roots');
    expect(fx.opened).toHaveLength(1);
  });
});

describe('FileManager — measuring for verification', () => {
  it('reports what is on disk, and nothing for a missing path', async () => {
    fx = fsFixture();
    fx.write('Documents/d/a.txt', 'abc');
    fx.write('Documents/d/b.txt', 'de');
    expect(await fx.manager.measure('Documents/d')).toEqual({
      kind: 'directory',
      files: 2,
      bytes: 5,
    });
    expect(await fx.manager.measure('Documents/d/a.txt')).toEqual({
      kind: 'file',
      files: 1,
      bytes: 3,
    });
    expect(await fx.manager.measure('Documents/nothing')).toBeUndefined();
    expect((await fx.manager.readBack('Documents/d/a.txt'))?.toString()).toBe('abc');
  });
});
