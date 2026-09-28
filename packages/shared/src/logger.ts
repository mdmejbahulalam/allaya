import { redact } from './redaction';

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): void;
}

const RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Structured logger. Every record is passed through secret redaction before reaching a sink. */
export class StructuredLogger implements Logger {
  constructor(
    private readonly sinks: LogSink[],
    private readonly scope = 'app',
    private readonly minLevel: LogLevel = 'INFO',
    private readonly now: () => Date = () => new Date(),
  ) {}

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (RANK[level] < RANK[this.minLevel]) return;
    const record: LogRecord = {
      timestamp: this.now().toISOString(),
      level,
      scope: this.scope,
      message: redact(message),
      ...(data ? { data: redact(data) } : {}),
    };
    for (const sink of this.sinks) {
      try {
        sink.write(record);
      } catch {
        // A failing sink must never break the application.
      }
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.log('INFO', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.log('WARN', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.log('ERROR', message, data);
  }
  child(scope: string): Logger {
    return new StructuredLogger(this.sinks, `${this.scope}.${scope}`, this.minLevel, this.now);
  }
}

export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  constructor(private readonly capacity = 1000) {}
  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.capacity) this.records.shift();
  }
}

export class ConsoleSink implements LogSink {
  write(record: LogRecord): void {
    const line = `${record.timestamp} ${record.level} [${record.scope}] ${record.message}`;
    const fn =
      record.level === 'ERROR'
        ? console.error
        : record.level === 'WARN'
          ? console.warn
          : console.log;
    if (record.data) fn(line, record.data);
    else fn(line);
  }
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
