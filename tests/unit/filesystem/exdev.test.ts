import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsFixture, type FsFixture } from '../../helpers/fs-fixture';

// Simulates moving between drives: rename() fails with EXDEV, exactly as it does across Windows volumes.
const state = vi.hoisted(() => ({ crossDrive: false, failCopyOf: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (state.crossDrive) {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      }
      return actual.rename(from, to);
    },
    copyFile: async (from: string, to: string, mode?: number) => {
      if (state.failCopyOf && from.endsWith(state.failCopyOf)) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return actual.copyFile(from, to, mode);
    },
  };
});

let fx: FsFixture;
afterEach(() => {
  state.crossDrive = false;
  state.failCopyOf = '';
  fx?.cleanup();
});

describe('moving between drives (EXDEV)', () => {
  it('copies, proves the copy, and only then sends the original to the trash', async () => {
    fx = fsFixture();
    fx.write('Documents/a.txt', 'payload');
    state.crossDrive = true;
    const result = await fx.manager.move('Documents/a.txt', 'Desktop');
    expect(result.crossDrive).toBe(true);
    expect(readFileSync(join(fx.desktop, 'a.txt'), 'utf8')).toBe('payload');
    expect(existsSync(join(fx.documents, 'a.txt'))).toBe(false);
    expect(readdirSync(join(fx.appData, 'trash'))).toHaveLength(1); // the original is recoverable
    const entry = fx.journal.get(result.actionId!)!;
    expect(entry.undoable).toBe(false);
    expect(entry.note).toContain('Recycle Bin');
  });

  it('moves a whole folder across drives', async () => {
    fx = fsFixture();
    fx.write('Documents/proj/src/a.txt', 'A');
    fx.write('Documents/proj/b.txt', 'B');
    state.crossDrive = true;
    await fx.manager.move('Documents/proj', 'Desktop');
    expect(readFileSync(join(fx.desktop, 'proj', 'src', 'a.txt'), 'utf8')).toBe('A');
    expect(existsSync(join(fx.documents, 'proj'))).toBe(false);
  });

  it('keeps the original, and leaves no half-copy, when the copy fails', async () => {
    fx = fsFixture();
    fx.write('Documents/proj/a.txt', 'A');
    fx.write('Documents/proj/z-fails.txt', 'Z');
    state.crossDrive = true;
    state.failCopyOf = 'z-fails.txt';
    await expect(fx.manager.move('Documents/proj', 'Desktop')).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
    });
    expect(readFileSync(join(fx.documents, 'proj', 'z-fails.txt'), 'utf8')).toBe('Z');
    expect(readFileSync(join(fx.documents, 'proj', 'a.txt'), 'utf8')).toBe('A');
    expect(existsSync(join(fx.desktop, 'proj'))).toBe(false);
  });

  it('reports a full disk in words a person can act on, without a path in it', async () => {
    fx = fsFixture();
    fx.write('Documents/a.txt', 'A');
    state.failCopyOf = 'a.txt';
    const error = await fx.manager.copy('Documents/a.txt', 'Desktop').then(
      () => new Error('it should have failed'),
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain('disk is full');
    expect(error.message).not.toContain(fx.base);
    expect(readdirSync(fx.desktop)).toEqual([]);
  });
});
