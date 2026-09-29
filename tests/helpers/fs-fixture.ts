import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppTrash,
  FileManager,
  MemoryJournal,
  PathPolicy,
  type FileLimits,
  type FolderRoot,
  type PathPlatform,
} from '@allaya/filesystem';

export interface FsFixture {
  /** Real temporary directory holding everything below. */
  base: string;
  documents: string;
  desktop: string;
  /** A folder that is NOT a root: nothing here may ever be touched. */
  outside: string;
  /** Stand-in for Allaya's own data folder. */
  appData: string;
  roots: FolderRoot[];
  policy: PathPolicy;
  manager: FileManager;
  journal: MemoryJournal;
  trash: AppTrash;
  opened: string[];
  write(relative: string, content?: string | Buffer): string;
  dir(relative: string): string;
  cleanup(): void;
}

export function fsFixture(
  options: {
    limits?: Partial<FileLimits>;
    platform?: PathPlatform;
    extraRoots?: FolderRoot[];
  } = {},
): FsFixture {
  // realpath: on some systems the temp dir is itself reached through a link (macOS /tmp).
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'allaya-fs-')));
  const documents = join(base, 'Documents');
  const desktop = join(base, 'Desktop');
  const outside = join(base, 'Outside');
  const appData = join(base, 'Support', 'Allaya');
  for (const dir of [documents, desktop, outside, appData]) mkdirSync(dir, { recursive: true });

  const roots: FolderRoot[] = [
    {
      id: 'documents',
      label: 'Documents',
      path: documents,
      aliases: ['ডকুমেন্টস'],
      origin: 'known',
    },
    { id: 'desktop', label: 'Desktop', path: desktop, aliases: ['ডেস্কটপ'], origin: 'known' },
    ...(options.extraRoots ?? []),
  ];
  const policy = new PathPolicy({
    roots: () => roots,
    protectedPaths: [appData],
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const trash = new AppTrash(join(appData, 'trash'));
  const journal = new MemoryJournal();
  const opened: string[] = [];
  const manager = new FileManager({
    policy,
    trash,
    backups: trash,
    journal,
    opener: (path) => {
      opened.push(path);
      return Promise.resolve();
    },
    ...(options.limits ? { limits: options.limits } : {}),
  });

  return {
    base,
    documents,
    desktop,
    outside,
    appData,
    roots,
    policy,
    manager,
    journal,
    trash,
    opened,
    write(relative, content = 'hello') {
      const full = join(base, relative);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
    dir(relative) {
      const full = join(base, relative);
      mkdirSync(full, { recursive: true });
      return full;
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
