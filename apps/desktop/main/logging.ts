import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConsoleSink,
  StructuredLogger,
  type LogLevel,
  type LogRecord,
  type LogSink,
} from '@allaya/shared';

/** Appends redacted JSON lines to a per-day file; keeps the most recent `retainDays` files. */
export class FileLogSink implements LogSink {
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void>;

  constructor(
    private readonly dir: string,
    private readonly retainDays = 7,
  ) {
    this.ready = this.prepare();
  }

  private async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir))
      .filter((f) => /^allaya-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - this.retainDays))) {
      await rm(join(this.dir, stale), { force: true });
    }
  }

  write(record: LogRecord): void {
    const day = record.timestamp.slice(0, 10);
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => appendFile(join(this.dir, `allaya-${day}.log`), line, 'utf8'))
      .catch(() => undefined);
  }

  /** Resolves when all queued writes have been flushed (used on shutdown and in tests). */
  flush(): Promise<void> {
    return this.queue;
  }
}

export function createLogger(options: { logsDir: string; level: LogLevel; console: boolean }) {
  const file = new FileLogSink(options.logsDir);
  const sinks: LogSink[] = [file];
  if (options.console) sinks.push(new ConsoleSink());
  return { logger: new StructuredLogger(sinks, 'main', options.level), file };
}
