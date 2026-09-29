import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { KNOWN_FOLDERS, type FolderRoot, type KnownFolderId } from '@allaya/filesystem';
import type { FileBookmarkRepository } from '@allaya/database';

/**
 * The folders Allaya may use: the operating system's known folders plus the ones the user added through the
 * folder picker. Read from the database on each use, so adding or removing a folder takes effect immediately.
 */
export class FolderRoots {
  constructor(
    private readonly known: Partial<Record<KnownFolderId, string>>,
    private readonly bookmarks: FileBookmarkRepository,
  ) {}

  list(): FolderRoot[] {
    const known: FolderRoot[] = KNOWN_FOLDERS.flatMap((folder) => {
      const path = this.known[folder.id];
      return path
        ? [
            {
              id: folder.id,
              label: folder.label,
              path,
              aliases: folder.aliases,
              origin: 'known' as const,
            },
          ]
        : [];
    });
    const user: FolderRoot[] = this.bookmarks
      .list('user')
      .map((row) => ({ id: row.id, label: row.label, path: row.path, origin: 'user' as const }));
    return [...known, ...user];
  }

  /** A name for a newly added folder that does not collide with an existing folder's name. */
  uniqueLabel(path: string): string {
    const base =
      basename(path)
        .replace(/[\\/:*?"<>|]/g, '-')
        .trim() || 'Folder';
    const taken = new Set(
      this.list().flatMap((root) =>
        [root.id, root.label, ...(root.aliases ?? [])].map((name) => name.toLowerCase()),
      ),
    );
    let label = base;
    for (let n = 2; taken.has(label.toLowerCase()); n += 1) label = `${base} (${n})`;
    return label;
  }
}

export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(realpathSync(path)).isDirectory();
  } catch {
    return false;
  }
}
