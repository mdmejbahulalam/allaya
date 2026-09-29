import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AllayaError } from '@allaya/shared';
import { isProgramFile, extensionOf } from './extensions';
import { explain, fingerprintOf, lstatOrUndefined, walkTree } from './fsutil';
import {
  latestUndoable,
  type JournalEntry,
  type JournalKind,
  type JournalStore,
  type UndoData,
} from './journal';
import { type PathPolicy, refusal, type ResolvedPath } from './paths';
import { checkSegments, isSearchSkipped } from './sensitive';
import type { AppTrash, TrashProvider } from './trash';
import type { EntryKind, FileEntry, FileInfo } from './types';

export interface FileLimits {
  maxReadChars: number;
  maxListEntries: number;
  searchMaxEntries: number;
  searchMaxDepth: number;
  maxWriteBytes: number;
  copyMaxEntries: number;
  copyMaxBytes: number;
}

export const DEFAULT_LIMITS: Readonly<FileLimits> = {
  maxReadChars: 100_000,
  maxListEntries: 1000,
  searchMaxEntries: 20_000,
  searchMaxDepth: 8,
  maxWriteBytes: 2_000_000,
  copyMaxEntries: 5000,
  copyMaxBytes: 1024 * 1024 * 1024,
};

export interface FileManagerOptions {
  policy: PathPolicy;
  /** Where deletes go (the Recycle Bin in production). */
  trash: TrashProvider;
  /** Holds the previous version of an overwritten file so the overwrite can be undone. */
  backups: AppTrash;
  journal: JournalStore;
  /** Opens a file with its default program. Absent where the host cannot. */
  opener?: (absolutePath: string) => Promise<void>;
  limits?: Partial<FileLimits>;
  now?: () => number;
  /** Where problems that must not fail an action (a journal that could not be written) are reported. */
  warn?: (message: string, error: unknown) => void;
}

const kindOf = (info: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): EntryKind =>
  info.isSymbolicLink()
    ? 'link'
    : info.isDirectory()
      ? 'directory'
      : info.isFile()
        ? 'file'
        : 'other';

const isHiddenName = (name: string) =>
  name.startsWith('.') || /^(desktop\.ini|thumbs\.db)$/i.test(name);

export interface ListResult {
  path: string;
  entries: FileEntry[];
  total: number;
  truncated: boolean;
  /** Entries left out because their names mark them as secrets. */
  omitted: number;
}

export interface ReadResult {
  path: string;
  text: string;
  characters: number;
  bytes: number;
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  name: string;
  kind: EntryKind;
  size: number;
  modifiedAt: number;
}

export interface SearchResult {
  hits: SearchHit[];
  scanned: number;
  /** A limit stopped the search, so a file that exists may not have been found. */
  truncated: boolean;
}

export interface WriteResult {
  path: string;
  bytes: number;
  created: boolean;
  overwrote: boolean;
  /** Absent when the undo journal could not be written (the action still happened). */
  actionId?: string | undefined;
}

export interface CopyResult {
  path: string;
  kind: 'file' | 'directory';
  files: number;
  folders: number;
  bytes: number;
  skippedLinks: number;
  skippedSecrets: number;
  /** Absent when the undo journal could not be written (the action still happened). */
  actionId?: string | undefined;
}

export interface MoveResult {
  from: string;
  path: string;
  /** Absent when the undo journal could not be written (the action still happened). */
  actionId?: string | undefined;
  crossDrive: boolean;
}

export interface TrashResult {
  path: string;
  kind: 'file' | 'directory';
  items: number;
  restorable: boolean;
  /** Absent when the undo journal could not be written (the action still happened). */
  actionId?: string | undefined;
}

export interface UndoResult {
  /** Absent when the undo journal could not be written (the action still happened). */
  actionId?: string | undefined;
  kind: JournalKind;
  label: string;
  outcome: string;
}

export interface FolderResult {
  path: string;
  created: boolean;
  actionId?: string;
}

/**
 * Every file operation Allaya performs, behind one guard. Nothing here takes a raw path: each entry point resolves
 * it through the {@link PathPolicy} first, so "inside an allowed folder, not a secret, not through a link" holds for
 * every caller — the model's tools and the Files screen alike.
 *
 * The operations are conservative by construction: nothing is ever overwritten silently (writing over a file backs
 * the old version up first), nothing is ever permanently deleted (deletes go to the trash), and everything that
 * changes something is recorded so it can be undone while doing so is still safe.
 */
export class FileManager {
  readonly limits: FileLimits;
  private readonly now: () => number;

  constructor(private readonly options: FileManagerOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  get policy(): PathPolicy {
    return this.options.policy;
  }

  get journal(): JournalStore {
    return this.options.journal;
  }

  /** Whether an undo can put a deleted item back (false with the Windows Recycle Bin). */
  get deletesAreRestorable(): boolean {
    return this.options.trash.restorable;
  }

  // ── reading ──────────────────────────────────────────────────────────────────────────────────────────────

  async list(
    input: string,
    options: { showHidden?: boolean; limit?: number } = {},
  ): Promise<ListResult> {
    const target = await this.options.policy.resolve(input, { mode: 'read' });
    const limit = Math.min(options.limit ?? 200, this.limits.maxListEntries);
    try {
      const names = await readdir(target.path);
      let omitted = 0;
      const entries: FileEntry[] = [];
      for (const name of names) {
        if (checkSegments([name], 'read')) {
          omitted += 1;
          continue;
        }
        if (!options.showHidden && isHiddenName(name)) continue;
        const info = await lstat(join(target.path, name)).catch(() => undefined);
        if (!info) continue; // vanished while listing
        entries.push({
          name,
          kind: kindOf(info),
          size: info.isFile() ? info.size : 0,
          modifiedAt: Math.round(info.mtimeMs),
          hidden: isHiddenName(name),
        });
      }
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      entries.sort(
        (a, b) =>
          Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
          collator.compare(a.name, b.name),
      );
      return {
        path: target.display,
        entries: entries.slice(0, limit),
        total: entries.length,
        truncated: entries.length > limit,
        omitted,
      };
    } catch (error) {
      throw explain(error, `list "${target.display}"`);
    }
  }

  async info(input: string): Promise<FileInfo> {
    const target = await this.options.policy.resolve(input, { mode: 'read', follow: false });
    const info = await lstat(target.path).catch((error) => {
      throw explain(error, `look at "${target.display}"`);
    });
    return {
      name: target.name,
      path: target.display,
      kind: kindOf(info),
      size: info.isFile() ? info.size : 0,
      modifiedAt: Math.round(info.mtimeMs),
      createdAt: Math.round(info.birthtimeMs),
      extension: extensionOf(target.name),
      hidden: isHiddenName(target.name),
    };
  }

  /** Reads a text file. Refuses binary files, and never reads more than `maxChars` characters. */
  async readText(input: string, maxChars = 20_000): Promise<ReadResult> {
    const target = await this.options.policy.resolve(input, { mode: 'read' });
    const limit = Math.min(Math.max(1, maxChars), this.limits.maxReadChars);
    const info = await stat(target.path).catch((error) => {
      throw explain(error, `read "${target.display}"`);
    });
    if (!info.isFile()) throw refusal('not_file', `"${target.display}" is a folder, not a file`);

    const wanted = Math.min(info.size, limit * 4 + 4);
    const handle = await open(target.path, 'r').catch((error) => {
      throw explain(error, `read "${target.display}"`);
    });
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const text = decodeText(bytes, info.size > bytes.length);
    if (text === undefined) {
      throw refusal(
        'not_text',
        `"${target.display}" is not a text file (it looks like ${extensionOf(target.name) || 'binary'} data)`,
      );
    }
    const chars = Array.from(text);
    const truncated = info.size > bytes.length || chars.length > limit;
    return {
      path: target.display,
      text: chars.slice(0, limit).join(''),
      characters: Math.min(chars.length, limit),
      bytes: info.size,
      truncated,
    };
  }

  /**
   * Finds files and folders by name. It never follows links, skips folders full of generated or secret content
   * (`node_modules`, `.git`, browser profiles…), and stops at fixed limits so that it cannot run away.
   */
  async search(options: {
    query: string;
    folder?: string | undefined;
    extension?: string | undefined;
    kind?: 'file' | 'directory' | 'any' | undefined;
    maxResults?: number | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<SearchResult> {
    const terms = options.query
      .normalize('NFC')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t !== '');
    const extension = options.extension?.replace(/^\./, '').toLowerCase();
    if (terms.length === 0 && !extension)
      throw new AllayaError('Give a name or an extension to search for', { code: 'INVALID_INPUT' });
    const maxResults = Math.min(options.maxResults ?? 30, 100);
    const kind = options.kind ?? 'any';

    const starts: ResolvedPath[] = options.folder
      ? [await this.options.policy.resolve(options.folder, { mode: 'read' })]
      : await this.allRoots();

    const hits: SearchHit[] = [];
    let scanned = 0;
    let truncated = false;
    const queue: Array<{ path: string; depth: number; display: string }> = starts.map((s) => ({
      path: s.path,
      depth: 0,
      display: s.display,
    }));

    while (queue.length > 0 && !truncated) {
      options.signal?.throwIfAborted();
      const dir = queue.shift()!;
      const dirents = await readdir(dir.path, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents) {
        if (scanned >= this.limits.searchMaxEntries || hits.length >= maxResults) {
          truncated = true;
          break;
        }
        scanned += 1;
        const name = dirent.name;
        if (checkSegments([name], 'read')) continue;
        const isLink = dirent.isSymbolicLink();
        const isDir = !isLink && dirent.isDirectory();
        const entryKind: EntryKind = isLink
          ? 'link'
          : isDir
            ? 'directory'
            : dirent.isFile()
              ? 'file'
              : 'other';
        const lower = name.normalize('NFC').toLowerCase();
        const kindOk = kind === 'any' || kind === entryKind;
        const extOk = !extension || extensionOf(name) === extension;
        if (kindOk && extOk && terms.every((term) => lower.includes(term))) {
          const info = await lstat(join(dir.path, name)).catch(() => undefined);
          if (info) {
            hits.push({
              path: `${dir.display}/${name}`,
              name,
              kind: entryKind,
              size: info.isFile() ? info.size : 0,
              modifiedAt: Math.round(info.mtimeMs),
            });
          }
        }
        if (isDir && !isSearchSkipped(name)) {
          if (dir.depth + 1 <= this.limits.searchMaxDepth) {
            queue.push({
              path: join(dir.path, name),
              depth: dir.depth + 1,
              display: `${dir.display}/${name}`,
            });
          } else {
            truncated = true;
          }
        }
      }
    }
    return { hits, scanned, truncated: truncated || queue.length > 0 };
  }

  /** Confirms what is on disk at `input`, for verification after a change. */
  async measure(
    input: string,
  ): Promise<{ kind: EntryKind; files: number; bytes: number } | undefined> {
    const target = await this.options.policy.resolve(input, { mode: 'read', follow: false });
    const info = await lstatOrUndefined(target.path);
    if (!info) return undefined;
    if (info.isDirectory()) {
      const { stats } = await walkTree(target.path, { maxEntries: this.limits.copyMaxEntries });
      return { kind: 'directory', files: stats.files, bytes: stats.bytes };
    }
    return {
      kind: kindOf(info),
      files: info.isFile() ? 1 : 0,
      bytes: info.isFile() ? info.size : 0,
    };
  }

  /** The exact text of a file, for verifying a write. `undefined` if it is not there. */
  async readBack(input: string): Promise<Buffer | undefined> {
    const target = await this.options.policy.resolve(input, { mode: 'read', follow: false });
    return readFile(target.path).catch(() => undefined);
  }

  // ── changing ─────────────────────────────────────────────────────────────────────────────────────────────

  async createFolder(input: string): Promise<FolderResult> {
    const target = await this.options.policy.resolve(input, { mode: 'write', follow: false });
    if (target.isRoot) return { path: target.display, created: false };
    this.options.policy.assertName(target.name);
    const existing = await lstatOrUndefined(target.path);
    if (existing) {
      if (existing.isDirectory()) return { path: target.display, created: false };
      throw refusal('exists', `"${target.display}" already exists and is not a folder`, 'CONFLICT');
    }
    // Remember every folder that will be created, so an undo can remove exactly those (and only if still empty).
    const created: string[] = [];
    let cursor = target.path;
    while (!(await lstatOrUndefined(cursor))) {
      created.unshift(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    try {
      await mkdir(target.path, { recursive: true });
    } catch (error) {
      throw explain(error, `create the folder "${target.display}"`);
    }
    const actionId = this.record('create_folder', target.display, {
      data: { type: 'create_folder', paths: created },
    });
    return { path: target.display, created: true, actionId };
  }

  async writeFile(
    input: string,
    content: string,
    options: { overwrite?: boolean } = {},
  ): Promise<WriteResult> {
    const target = await this.options.policy.resolve(input, { mode: 'write', follow: false });
    if (target.isRoot) throw refusal('is_root', 'That is a folder, not a file', 'INVALID_INPUT');
    this.options.policy.assertName(target.name);
    const data = Buffer.from(content, 'utf8');
    if (data.length > this.limits.maxWriteBytes) {
      throw refusal(
        'too_large',
        `That text is too large to write (limit ${Math.round(this.limits.maxWriteBytes / 1_000_000)} MB)`,
        'INVALID_INPUT',
      );
    }
    const parent = await lstatOrUndefined(dirname(target.path));
    if (!parent?.isDirectory()) {
      throw refusal(
        'missing',
        `The folder for "${target.display}" does not exist; create it first`,
        'NOT_FOUND',
      );
    }
    const existing = await lstatOrUndefined(target.path);
    if (existing && !options.overwrite) {
      throw refusal(
        'exists',
        `"${target.display}" already exists. Choose another name, or ask to replace it (the old version is kept so it can be restored)`,
        'CONFLICT',
      );
    }
    if (existing && !existing.isFile()) {
      throw refusal(
        'not_file',
        `"${target.display}" is not a regular file, so it cannot be replaced`,
      );
    }

    try {
      if (existing) return await this.replaceFile(target, data);
      const handle = await open(target.path, 'wx');
      try {
        await handle.writeFile(data);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(target.path).catch(() => undefined); // our own half-written file
        throw error;
      }
      await handle.close();
      const after = await stat(target.path);
      const actionId = this.record('create_file', target.display, {
        data: {
          type: 'create_file',
          path: target.path,
          size: after.size,
          mtimeMs: Math.round(after.mtimeMs),
        },
      });
      return { path: target.display, bytes: after.size, created: true, overwrote: false, actionId };
    } catch (error) {
      throw explain(error, `write "${target.display}"`);
    }
  }

  private async replaceFile(target: ResolvedPath, data: Buffer): Promise<WriteResult> {
    // 1. Keep the previous version. 2. Write the new one beside it. 3. Swap. A failure at any step leaves the
    // original in place.
    const backupId = await this.options.backups.stash(target.path);
    const temp = join(dirname(target.path), `.allaya-${randomUUID().slice(0, 8)}.tmp`);
    try {
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      await rename(temp, target.path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      await this.options.backups.discard(backupId).catch(() => undefined);
      throw error;
    }
    const after = await stat(target.path);
    const actionId = this.record('overwrite', target.display, {
      data: {
        type: 'overwrite',
        path: target.path,
        backupId,
        size: after.size,
        mtimeMs: Math.round(after.mtimeMs),
      },
    });
    return { path: target.display, bytes: after.size, created: false, overwrote: true, actionId };
  }

  async copy(
    sourceInput: string,
    destinationFolder: string,
    options: { newName?: string | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<CopyResult> {
    const source = await this.options.policy.resolve(sourceInput, { mode: 'read' });
    const folder = await this.options.policy.resolve(destinationFolder, { mode: 'write' });
    const name = this.options.policy.assertName(options.newName ?? source.name);
    const info = await stat(source.path).catch((error) => {
      throw explain(error, `copy "${source.display}"`);
    });
    const destination = await this.destinationIn(folder, name, source.path, info.isDirectory());

    try {
      const outcome = info.isDirectory()
        ? await this.copyTree(source.path, destination, options.signal)
        : await this.copyOne(source.path, destination);
      const shown = `${folder.display}/${name}`;
      const actionId = this.record('copy', source.display, {
        target: shown,
        data: {
          type: 'copy',
          path: destination,
          isDirectory: info.isDirectory(),
          fingerprint: await this.fingerprintPath(destination),
        },
      });
      return { path: shown, kind: info.isDirectory() ? 'directory' : 'file', actionId, ...outcome };
    } catch (error) {
      throw explain(error, `copy "${source.display}"`);
    }
  }

  async move(
    sourceInput: string,
    destinationFolder: string,
    options: { newName?: string | undefined } = {},
  ): Promise<MoveResult> {
    const source = await this.options.policy.resolve(sourceInput, { mode: 'write', follow: false });
    if (source.isRoot)
      throw refusal(
        'is_root',
        `"${source.display}" is one of your main folders and cannot be moved`,
      );
    const folder = await this.options.policy.resolve(destinationFolder, { mode: 'write' });
    const name = this.options.policy.assertName(options.newName ?? source.name);
    const info = await lstat(source.path).catch((error) => {
      throw explain(error, `move "${source.display}"`);
    });
    const destination = await this.destinationIn(folder, name, source.path, info.isDirectory());
    return this.relocate(source, info.isDirectory(), destination, `${folder.display}/${name}`);
  }

  /** Renames in place. `newName` is a name, never a path. */
  async rename(sourceInput: string, newName: string): Promise<MoveResult> {
    const source = await this.options.policy.resolve(sourceInput, { mode: 'write', follow: false });
    if (source.isRoot)
      throw refusal(
        'is_root',
        `"${source.display}" is one of your main folders and cannot be renamed`,
      );
    const name = this.options.policy.assertName(newName);
    const info = await lstat(source.path).catch((error) => {
      throw explain(error, `rename "${source.display}"`);
    });
    const destination = join(dirname(source.path), name);
    if (destination === source.path) {
      throw refusal('exists', `"${source.display}" already has that name`, 'CONFLICT');
    }
    const shown = [...source.display.split('/').slice(0, -1), name].join('/');
    return this.relocate(source, info.isDirectory(), destination, shown);
  }

  /** Sends a file (or, with `folder`, a whole folder) to the trash. Never deletes permanently. */
  async trash(input: string, options: { folder: boolean }): Promise<TrashResult> {
    const target = await this.options.policy.resolve(input, { mode: 'write', follow: false });
    if (target.isRoot) {
      throw refusal(
        'is_root',
        `"${target.display}" is one of your main folders and cannot be deleted`,
      );
    }
    const info = await lstat(target.path).catch((error) => {
      throw explain(error, `delete "${target.display}"`);
    });
    const isDirectory = info.isDirectory();
    if (isDirectory && !options.folder) {
      throw refusal(
        'not_file',
        `"${target.display}" is a folder; deleting a folder is a separate, more careful action`,
        'INVALID_INPUT',
      );
    }
    if (!isDirectory && options.folder) {
      throw refusal(
        'not_directory',
        `"${target.display}" is a file, not a folder`,
        'INVALID_INPUT',
      );
    }
    const items = isDirectory
      ? 1 + (await walkTree(target.path, { maxEntries: 10_000 })).entries.length
      : 1;

    let restoreId: string | undefined;
    try {
      ({ restoreId } = await this.options.trash.trash(target.path));
    } catch (error) {
      throw explain(error, `move "${target.display}" to the trash`);
    }
    // Independent proof: it is no longer where it was.
    if (await lstatOrUndefined(target.path)) {
      throw new AllayaError(`"${target.display}" is still in place after moving it to the trash`, {
        code: 'VERIFICATION_FAILED',
      });
    }
    const restorable = this.options.trash.restorable && restoreId !== undefined;
    const actionId = this.record('trash', target.display, {
      undoable: restorable,
      ...(restorable
        ? { data: { type: 'trash', path: target.path, restoreId: restoreId! } satisfies UndoData }
        : {
            note: `It is in the ${this.options.trash.name === 'allaya-trash' ? 'Allaya trash' : 'Recycle Bin'}; restore it from there.`,
          }),
    });
    return {
      path: target.display,
      kind: isDirectory ? 'directory' : 'file',
      items,
      restorable,
      actionId,
    };
  }

  async open(input: string): Promise<{ path: string }> {
    const target = await this.options.policy.resolve(input, { mode: 'read' });
    if (!this.options.opener) {
      throw new AllayaError('Opening files is not available here', {
        code: 'UNSUPPORTED_PLATFORM',
      });
    }
    const info = await stat(target.path).catch((error) => {
      throw explain(error, `open "${target.display}"`);
    });
    if (!info.isFile())
      throw refusal('not_file', `"${target.display}" is a folder, not a file`, 'INVALID_INPUT');
    if (isProgramFile(target.name)) {
      throw refusal('program_file', 'Allaya does not open programs, scripts or shortcuts');
    }
    try {
      await this.options.opener(target.path);
    } catch (error) {
      throw explain(error, `open "${target.display}"`);
    }
    return { path: target.display };
  }

  // ── undo ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** What `undo` would reverse next, for the confirmation text. */
  nextUndo(id?: string): JournalEntry | undefined {
    return id ? this.options.journal.get(id) : latestUndoable(this.options.journal);
  }

  async undo(id?: string): Promise<UndoResult> {
    const entry = this.nextUndo(id);
    if (!entry) throw refusal('not_undoable', 'There is nothing to undo', 'NOT_FOUND');
    if (entry.undoneAt !== undefined)
      throw refusal('not_undoable', 'That action was already undone', 'CONFLICT');
    if (!entry.undoable || !entry.data) {
      throw refusal('not_undoable', entry.note ?? 'That action cannot be undone by Allaya');
    }
    const policy = this.options.policy;
    const data = entry.data;
    const changed = (what: string) =>
      refusal(
        'changed',
        `${what} changed since Allaya made the change, so undoing it could lose your work`,
        'CONFLICT',
      );
    let outcome: string;

    switch (data.type) {
      case 'create_file': {
        const target = await policy.resolve(data.path, { mode: 'write', follow: false });
        const info = await lstatOrUndefined(target.path);
        if (
          !info?.isFile() ||
          info.size !== data.size ||
          Math.round(info.mtimeMs) !== data.mtimeMs
        ) {
          throw changed(`"${entry.label}" is missing or`);
        }
        await this.options.trash.trash(target.path);
        outcome = `Moved "${entry.label}" to the trash`;
        break;
      }
      case 'create_folder': {
        const ordered = [...data.paths].reverse(); // deepest first
        const targets: ResolvedPath[] = [];
        for (const path of ordered) {
          const target = await policy.resolve(path, { mode: 'write', follow: false });
          if (await lstatOrUndefined(target.path)) targets.push(target);
        }
        const removing = new Set(targets.map((target) => target.path));
        for (const target of targets) {
          const info = await lstat(target.path);
          const names = info.isDirectory() ? await readdir(target.path) : ['?'];
          // Content that Allaya did not create — anything but the folders being removed — stops the undo.
          if (names.some((name) => !removing.has(join(target.path, name)))) {
            throw changed(`"${entry.label}" now has content or`);
          }
        }
        for (const target of targets) await rmdir(target.path);
        outcome = `Removed the empty folder "${entry.label}"`;
        break;
      }
      case 'overwrite': {
        const target = await policy.resolve(data.path, { mode: 'write', follow: false });
        const info = await lstatOrUndefined(target.path);
        if (
          !info?.isFile() ||
          info.size !== data.size ||
          Math.round(info.mtimeMs) !== data.mtimeMs
        ) {
          throw changed(`"${entry.label}" has`);
        }
        if (!(await this.options.backups.has(data.backupId))) {
          throw refusal(
            'not_undoable',
            'The previous version is no longer stored, so it cannot be restored',
          );
        }
        await this.options.trash.trash(target.path); // the version Allaya wrote stays recoverable too
        await this.options.backups.restore(data.backupId, target.path);
        outcome = `Restored the previous version of "${entry.label}"`;
        break;
      }
      case 'copy': {
        const target = await policy.resolve(data.path, { mode: 'write', follow: false });
        if ((await lstatOrUndefined(target.path)) === undefined)
          throw changed(`"${entry.target ?? entry.label}" is missing or`);
        if ((await this.fingerprintPath(target.path)) !== data.fingerprint) {
          throw changed(`The copy "${entry.target ?? entry.label}" has`);
        }
        await this.options.trash.trash(target.path);
        outcome = `Moved the copy "${entry.target ?? entry.label}" to the trash`;
        break;
      }
      case 'move': {
        const from = await policy.resolve(data.from, { mode: 'write', follow: false });
        const to = await policy.resolve(data.to, { mode: 'write', follow: false });
        if (!(await lstatOrUndefined(to.path)))
          throw changed(`"${entry.target ?? entry.label}" is missing or`);
        if (await lstatOrUndefined(from.path)) {
          throw refusal(
            'exists',
            `Something new is now at "${entry.label}", so it cannot be moved back`,
            'CONFLICT',
          );
        }
        if (!(await lstatOrUndefined(dirname(from.path)))) {
          throw refusal('missing', 'The original folder no longer exists', 'NOT_FOUND');
        }
        await rename(to.path, from.path);
        outcome = `Moved it back to "${entry.label}"`;
        break;
      }
      case 'trash': {
        const target = await policy.resolve(data.path, { mode: 'write', follow: false });
        if (await lstatOrUndefined(target.path)) {
          throw refusal(
            'exists',
            `Something new is now at "${entry.label}", so the deleted item was not restored`,
            'CONFLICT',
          );
        }
        if (!this.options.trash.restore) {
          throw refusal(
            'not_undoable',
            'Deleted items cannot be restored by Allaya; use the Recycle Bin',
          );
        }
        await this.options.trash.restore(data.restoreId, target.path);
        outcome = `Restored "${entry.label}" from the trash`;
        break;
      }
    }

    this.options.journal.markUndone(entry.id, this.now());
    return { actionId: entry.id, kind: entry.kind, label: entry.label, outcome };
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────────

  private async allRoots(): Promise<ResolvedPath[]> {
    const found: ResolvedPath[] = [];
    for (const root of this.options.policy.roots()) {
      try {
        found.push(await this.options.policy.resolve(root.label, { mode: 'read' }));
      } catch {
        /* a folder that is missing or unusable is simply not searched */
      }
    }
    return found;
  }

  /** Where `name` would go inside `folder`, after the checks common to copy and move. */
  private async destinationIn(
    folder: ResolvedPath,
    name: string,
    sourcePath: string,
    sourceIsDirectory: boolean,
  ): Promise<string> {
    const folderInfo = await stat(folder.path).catch((error) => {
      throw explain(error, `use the folder "${folder.display}"`);
    });
    if (!folderInfo.isDirectory()) {
      throw refusal('not_directory', `"${folder.display}" is not a folder`, 'INVALID_INPUT');
    }
    const destination = join(folder.path, name);
    if (sourceIsDirectory && this.options.policy.isInside(sourcePath, destination)) {
      throw refusal('exists', 'A folder cannot be copied or moved into itself', 'INVALID_INPUT');
    }
    if (await lstatOrUndefined(destination)) {
      throw refusal(
        'exists',
        `"${folder.display}/${name}" already exists. Nothing was overwritten; choose another name or folder`,
        'CONFLICT',
      );
    }
    return destination;
  }

  private async relocate(
    source: ResolvedPath,
    isDirectory: boolean,
    destination: string,
    shownDestination: string,
  ): Promise<MoveResult> {
    let crossDrive = false;
    try {
      // Last line of defence against overwriting (rename() replaces silently on most systems). The one exception is
      // a case-only rename on a case-insensitive disk, where "the destination" is the source itself.
      const occupant = await lstatOrUndefined(destination);
      if (occupant) {
        const own = await lstat(source.path);
        const same = occupant.ino !== 0 && occupant.ino === own.ino && occupant.dev === own.dev;
        if (!same) {
          throw refusal(
            'exists',
            `"${shownDestination}" already exists. Nothing was overwritten`,
            'CONFLICT',
          );
        }
      }
      try {
        await rename(source.path, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        crossDrive = true;
        const info = await lstat(source.path);
        if (info.isSymbolicLink()) throw error;
        // Different drive: copy, prove the copy, and only then move the original to the trash.
        const before = isDirectory
          ? (await walkTree(source.path, { maxEntries: this.limits.copyMaxEntries })).stats
          : undefined;
        const copied = isDirectory
          ? await this.copyTree(source.path, destination)
          : await this.copyOne(source.path, destination);
        const sameSize = isDirectory
          ? before !== undefined && before.files === copied.files && before.bytes === copied.bytes
          : (await stat(destination)).size === info.size;
        if (!sameSize) {
          throw new AllayaError('The copy does not match the original, so the original was kept', {
            code: 'VERIFICATION_FAILED',
          });
        }
        await this.options.trash.trash(source.path);
      }
    } catch (error) {
      throw explain(error, `move "${source.display}"`);
    }
    if (await lstatOrUndefined(source.path)) {
      throw new AllayaError(`"${source.display}" is still in its old place after the move`, {
        code: 'VERIFICATION_FAILED',
      });
    }
    const actionId = this.record('move', source.display, {
      target: shownDestination,
      undoable: !crossDrive,
      ...(crossDrive
        ? { note: 'It was moved to another drive; the original is in the Recycle Bin.' }
        : { data: { type: 'move', from: source.path, to: destination } satisfies UndoData }),
    });
    return { from: source.display, path: shownDestination, actionId, crossDrive };
  }

  private async copyOne(from: string, to: string) {
    const info = await stat(from);
    if (info.size > this.limits.copyMaxBytes) throw this.tooBig();
    await copyFile(from, to, constants.COPYFILE_EXCL); // atomic "must not exist"
    const bytes = (await stat(to)).size;
    if (bytes !== info.size) {
      await unlink(to).catch(() => undefined);
      throw new AllayaError('The copy is not the same size as the original', {
        code: 'VERIFICATION_FAILED',
      });
    }
    return { files: 1, folders: 0, bytes, skippedLinks: 0, skippedSecrets: 0 };
  }

  private async copyTree(from: string, to: string, signal?: AbortSignal) {
    // Measure first, so a too-large folder is refused before anything is written.
    const { entries, stats } = await walkTree(from, {
      maxEntries: this.limits.copyMaxEntries,
      signal,
    });
    if (stats.truncated) throw this.tooBig();
    if (stats.bytes > this.limits.copyMaxBytes) throw this.tooBig();
    await mkdir(to);
    try {
      for (const entry of entries) {
        signal?.throwIfAborted();
        const target = join(to, entry.relative);
        if (entry.kind === 'directory') await mkdir(target);
        else if (entry.kind === 'file')
          await copyFile(entry.absolute, target, constants.COPYFILE_EXCL);
        // links and special files are not copied
      }
    } catch (error) {
      // Undo our own half-finished copy: this folder did not exist before this call, so it holds only what we wrote.
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const copied = (await walkTree(to, { maxEntries: this.limits.copyMaxEntries + 1 })).stats;
    if (copied.files !== stats.files || copied.bytes !== stats.bytes) {
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw new AllayaError('The copy does not match the original', {
        code: 'VERIFICATION_FAILED',
      });
    }
    return {
      files: stats.files,
      folders: stats.directories,
      bytes: stats.bytes,
      skippedLinks: stats.links,
      skippedSecrets: stats.secrets,
    };
  }

  private tooBig(): AllayaError {
    return refusal(
      'too_large',
      `That is too large to copy in one step (limit ${this.limits.copyMaxEntries} items or ${Math.round(this.limits.copyMaxBytes / 1024 ** 3)} GB)`,
      'INVALID_INPUT',
    );
  }

  private async fingerprintPath(path: string): Promise<string> {
    const info = await lstat(path);
    if (info.isDirectory()) {
      return fingerprintOf(
        (await walkTree(path, { maxEntries: this.limits.copyMaxEntries + 1 })).stats,
      );
    }
    return `${info.size}:${Math.round(info.mtimeMs)}`;
  }

  /**
   * Writes the undo journal entry. The action has already happened by now, so a journal that cannot be written
   * must not turn a success into a failure: it is reported and the action simply cannot be undone.
   */
  private record(
    kind: JournalKind,
    label: string,
    extra: { target?: string; data?: UndoData; undoable?: boolean; note?: string },
  ): string | undefined {
    const id = randomUUID();
    try {
      this.options.journal.add({
        id,
        createdAt: this.now(),
        kind,
        label,
        target: extra.target,
        undoable: extra.undoable ?? extra.data !== undefined,
        note: extra.note,
        data: extra.data,
      });
      return id;
    } catch (error) {
      this.options.warn?.('Could not record a file action for undo', error);
      return undefined;
    }
  }
}

/**
 * Decodes the start of a file as text. `undefined` means "this is not text": a NUL byte (outside UTF-16), or a
 * lot of bytes that are not valid UTF-8. UTF-8 and UTF-16 byte-order marks are honoured (Notepad writes both).
 */
export function decodeText(bytes: Uint8Array, cutShort: boolean): string | undefined {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2), { stream: cutShort });
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2), { stream: cutShort });
  }
  const start =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const body = bytes.subarray(start);
  if (body.subarray(0, 8000).includes(0)) return undefined;
  const text = new TextDecoder('utf-8').decode(body, { stream: cutShort });
  const bad = (text.match(/�/g) ?? []).length;
  if (bad > 0 && bad / Math.max(1, text.length) > 0.02) return undefined;
  return text;
}
