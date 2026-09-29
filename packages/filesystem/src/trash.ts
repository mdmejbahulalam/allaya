import { randomUUID } from 'node:crypto';
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { AllayaError } from '@allaya/shared';
import { lstatOrUndefined } from './fsutil';

/** Where deleted things go. Deleting is never permanent: it is always a move to somewhere recoverable. */
export interface TrashProvider {
  readonly name: string;
  /** Whether Allaya itself can put an item back. The Windows Recycle Bin cannot be restored from code. */
  readonly restorable: boolean;
  trash(path: string): Promise<{ restoreId?: string }>;
  restore?(restoreId: string, to: string): Promise<void>;
}

interface Manifest {
  originalPath: string;
  trashedAt: number;
  isDirectory: boolean;
}

const ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * A recoverable holding area inside Allaya's own data folder. It backs file overwrites (so the previous version
 * can be restored) and stands in for the Recycle Bin where the operating system has none.
 */
export class AppTrash implements TrashProvider {
  readonly name = 'allaya-trash';
  readonly restorable = true;

  constructor(
    private readonly folder: string,
    private readonly now: () => number = Date.now,
  ) {}

  private slot(id: string): string {
    if (!ID_PATTERN.test(id)) throw new AllayaError('Invalid trash id', { code: 'INVALID_INPUT' });
    return join(this.folder, id);
  }

  /** Moves `path` (file or folder) into the trash. */
  async trash(path: string): Promise<{ restoreId: string }> {
    const id = randomUUID();
    const slot = this.slot(id);
    const info = await stat(path);
    await mkdir(slot, { recursive: true });
    await this.writeManifest(slot, {
      originalPath: path,
      trashedAt: this.now(),
      isDirectory: info.isDirectory(),
    });
    await this.move(path, join(slot, 'item'));
    return { restoreId: id };
  }

  /** Copies a file into the trash and leaves the original untouched (a backup, not a deletion). */
  async stash(path: string): Promise<string> {
    const id = randomUUID();
    const slot = this.slot(id);
    await mkdir(slot, { recursive: true });
    await this.writeManifest(slot, {
      originalPath: path,
      trashedAt: this.now(),
      isDirectory: false,
    });
    await copyFile(path, join(slot, 'item'));
    return id;
  }

  /** Moves the stored item to `to`, which must not exist. */
  async restore(restoreId: string, to: string): Promise<void> {
    const slot = this.slot(restoreId);
    await this.move(join(slot, 'item'), to);
    await rm(slot, { recursive: true, force: true });
  }

  async has(restoreId: string): Promise<boolean> {
    return stat(join(this.slot(restoreId), 'item')).then(
      () => true,
      () => false,
    );
  }

  async discard(restoreId: string): Promise<void> {
    await rm(this.slot(restoreId), { recursive: true, force: true });
  }

  /** Removes items older than `maxAgeMs`. Returns how many were removed. */
  async purge(maxAgeMs: number): Promise<number> {
    let removed = 0;
    const entries = await readdir(this.folder).catch(() => [] as string[]);
    for (const id of entries) {
      if (!ID_PATTERN.test(id)) continue;
      const manifest = await this.readManifest(join(this.folder, id));
      if (!manifest || this.now() - manifest.trashedAt > maxAgeMs) {
        await rm(join(this.folder, id), { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private async move(from: string, to: string): Promise<void> {
    // rename() silently replaces an existing file on most systems; nothing here may overwrite.
    if (await lstatOrUndefined(to)) {
      throw new AllayaError('The destination already exists', {
        code: 'CONFLICT',
        details: { reason: 'exists' },
      });
    }
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      // Different drive: copy (never overwriting), then remove the original.
      await cp(from, to, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
      await rm(from, { recursive: true, force: true });
    }
  }

  private async writeManifest(slot: string, manifest: Manifest): Promise<void> {
    await writeFile(join(slot, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  }

  private async readManifest(slot: string): Promise<Manifest | undefined> {
    try {
      return JSON.parse(await readFile(join(slot, 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      return undefined;
    }
  }
}
