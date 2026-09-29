import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScreenshotStore } from '@allaya/computer';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `Allaya-2026-09-29-14-05-33-123.png` — sortable, unique per millisecond, never overwrites. */
export function screenshotFileName(now: Date): string {
  return `Allaya-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.png`;
}

/** Saves screenshots into one fixed folder. The model never chooses the path. */
export class FolderScreenshotStore implements ScreenshotStore {
  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get folder(): string {
    return this.directory;
  }

  async save(bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, screenshotFileName(this.now()));
    // `wx`: fail rather than overwrite an existing file.
    await writeFile(path, bytes, { flag: 'wx' });
    return { path, bytes: bytes.byteLength };
  }

  async inspect(path: string): Promise<{ bytes: number; head: Uint8Array } | undefined> {
    try {
      const info = await stat(path);
      const handle = await open(path, 'r');
      try {
        const head = new Uint8Array(8);
        const { bytesRead } = await handle.read(head, 0, 8, 0);
        return { bytes: info.size, head: head.slice(0, bytesRead) };
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}
