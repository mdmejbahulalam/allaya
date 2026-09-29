import { lstat, readdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { AllayaError } from '@allaya/shared';
import { checkSegments } from './sensitive';

export const lstatOrUndefined = (path: string): Promise<Stats | undefined> =>
  lstat(path).then(
    (info) => info,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    },
  );

/**
 * Turns an operating-system error into one a person (and the model) can act on. No absolute paths in the text:
 * they are not needed to act, and the model should keep using the folder-relative form.
 */
export function explain(error: unknown, doing: string): AllayaError {
  if (error instanceof AllayaError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const make = (message: string, errorCode: AllayaError['code'], retryable = false) =>
    new AllayaError(message, {
      code: errorCode,
      retryable,
      cause: error,
      details: { errno: code },
    });
  switch (code) {
    case 'ENOENT':
      return make(`Could not ${doing}: it does not exist`, 'NOT_FOUND');
    case 'ENOTDIR':
      return make(`Could not ${doing}: part of the path is not a folder`, 'NOT_FOUND');
    case 'EEXIST':
      return make(`Could not ${doing}: something with that name already exists`, 'CONFLICT');
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return make(
        `Could not ${doing}: Windows denied access (it may be read-only or protected)`,
        'PERMISSION_DENIED',
      );
    case 'EBUSY':
    case 'ETXTBSY':
      return make(
        `Could not ${doing}: it is in use by another program`,
        'TOOL_EXECUTION_FAILED',
        true,
      );
    case 'ENOSPC':
      return make(`Could not ${doing}: the disk is full`, 'TOOL_EXECUTION_FAILED');
    case 'ENAMETOOLONG':
      return make(`Could not ${doing}: the path is too long`, 'INVALID_INPUT');
    case 'ENOTEMPTY':
      return make(`Could not ${doing}: the folder is not empty`, 'CONFLICT');
    case 'EISDIR':
      return make(`Could not ${doing}: that is a folder`, 'INVALID_INPUT');
    default:
      return make(`Could not ${doing}`, 'TOOL_EXECUTION_FAILED');
  }
}

export interface TreeStats {
  files: number;
  directories: number;
  bytes: number;
  /** Links are never followed or copied. */
  links: number;
  /** Entries with secret names: never copied. */
  secrets: number;
  maxMtimeMs: number;
  /** `true` when a limit stopped the walk. */
  truncated: boolean;
}

export interface WalkedEntry {
  /** Path relative to the walk's start. */
  relative: string;
  absolute: string;
  kind: 'file' | 'directory' | 'link' | 'other';
  size: number;
  mtimeMs: number;
}

/**
 * Walks a folder tree without following links, in a stable order, skipping entries with secret names.
 * Stops when `maxEntries` is reached (`truncated`), or when `signal` aborts.
 */
export async function walkTree(
  start: string,
  options: { maxEntries: number; signal?: AbortSignal | undefined },
): Promise<{ entries: WalkedEntry[]; stats: TreeStats }> {
  const entries: WalkedEntry[] = [];
  const stats: TreeStats = {
    files: 0,
    directories: 0,
    bytes: 0,
    links: 0,
    secrets: 0,
    maxMtimeMs: 0,
    truncated: false,
  };
  const queue: Array<{ absolute: string; relative: string }> = [{ absolute: start, relative: '' }];
  while (queue.length > 0) {
    options.signal?.throwIfAborted();
    const dir = queue.shift()!;
    const names = (await readdir(dir.absolute)).sort();
    for (const name of names) {
      if (entries.length >= options.maxEntries) {
        stats.truncated = true;
        return { entries, stats };
      }
      if (checkSegments([name], 'read')) {
        stats.secrets += 1;
        continue;
      }
      const absolute = join(dir.absolute, name);
      const relative = dir.relative ? join(dir.relative, name) : name;
      const info = await lstat(absolute);
      const kind = info.isSymbolicLink()
        ? 'link'
        : info.isDirectory()
          ? 'directory'
          : info.isFile()
            ? 'file'
            : 'other';
      entries.push({ relative, absolute, kind, size: info.size, mtimeMs: info.mtimeMs });
      stats.maxMtimeMs = Math.max(stats.maxMtimeMs, info.mtimeMs);
      if (kind === 'directory') {
        stats.directories += 1;
        queue.push({ absolute, relative });
      } else if (kind === 'file') {
        stats.files += 1;
        stats.bytes += info.size;
      } else {
        stats.links += 1;
      }
    }
  }
  return { entries, stats };
}

/** Identifies a folder's contents by shape: same count, size and newest change ⇒ nothing was touched. */
export const fingerprintOf = (stats: TreeStats): string =>
  `${stats.files}:${stats.directories}:${stats.bytes}:${Math.floor(stats.maxMtimeMs)}`;
