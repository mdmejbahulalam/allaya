import { afterEach, describe, expect, it } from 'vitest';
import {
  FileBookmarkRepository,
  FileOperationRepository,
  openDatabase,
  sourceMigrationsFolder,
  type DatabaseHandle,
} from '@allaya/database';

let handle: DatabaseHandle;
afterEach(() => handle?.close());
const open = () =>
  (handle = openDatabase({ path: ':memory:', migrationsFolder: sourceMigrationsFolder() }));

const op = (n: number, extra: Partial<Parameters<FileOperationRepository['add']>[0]> = {}) => ({
  id: `op-${String(n).padStart(4, '0')}`,
  kind: 'create_file',
  label: `Documents/f${n}.txt`,
  target: null,
  undoable: true,
  note: null,
  dataJson: '{"type":"create_file"}',
  createdAt: 1_000 + n,
  ...extra,
});

describe('FileOperationRepository', () => {
  it('stores entries, lists newest first, and marks them undone', () => {
    const repo = new FileOperationRepository(open().db);
    repo.add(op(1));
    repo.add(op(2));
    expect(repo.list(10).map((r) => r.id)).toEqual(['op-0002', 'op-0001']);
    expect(repo.get('op-0001')).toMatchObject({
      undoable: true,
      undoneAt: null,
      label: 'Documents/f1.txt',
    });
    repo.markUndone('op-0001', 5_000);
    expect(repo.get('op-0001')!.undoneAt).toBe(5_000);
    expect(repo.get('missing')).toBeUndefined();
  });

  it('stays bounded: past 200 entries the oldest fall away (regression: OFFSET needs a LIMIT in SQLite)', () => {
    const repo = new FileOperationRepository(open().db);
    for (let n = 1; n <= 230; n += 1) repo.add(op(n));
    const all = repo.list(500);
    expect(all).toHaveLength(200);
    expect(all[0]!.id).toBe('op-0230');
    expect(all.at(-1)!.id).toBe('op-0031');
    expect(repo.get('op-0001')).toBeUndefined();
  });
});

describe('FileBookmarkRepository', () => {
  it('adds user folders once per path and removes only user folders', () => {
    const repo = new FileBookmarkRepository(open().db, () => 1_000);
    expect(repo.addUserFolder('u1', 'Projects', '/data/Projects')).toMatchObject({
      label: 'Projects',
      kind: 'user',
    });
    expect(repo.addUserFolder('u2', 'Again', '/data/Projects')).toBeUndefined();
    repo.touchRecent('r1', 'a.txt', 'Documents/a.txt');
    expect(repo.list('user').map((r) => r.id)).toEqual(['u1']);
    expect(repo.removeUserFolder('r1')).toBe(false); // a recent entry is not a folder
    expect(repo.removeUserFolder('u1')).toBe(true);
    expect(repo.removeUserFolder('u1')).toBe(false);
  });

  it('keeps the newest 20 recent files, re-touching moves one to the top', () => {
    let clock = 0;
    const repo = new FileBookmarkRepository(open().db, () => (clock += 1));
    for (let n = 1; n <= 25; n += 1) repo.touchRecent(`r${n}`, `f${n}`, `Documents/f${n}`);
    const recent = repo.list('recent');
    expect(recent).toHaveLength(20);
    expect(recent[0]!.label).toBe('f25');
    expect(recent.at(-1)!.label).toBe('f6');
    repo.touchRecent('rX', 'f6', 'Documents/f6');
    expect(repo.list('recent')[0]!.label).toBe('f6');
    repo.clearRecent();
    expect(repo.list('recent')).toEqual([]);
  });
});
