import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { AllayaError } from '@allaya/shared';
import * as schema from './schema';

export type AllayaDb = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  /** Drizzle instance. Only ever used inside the trusted main process. */
  readonly db: AllayaDb;
  /** Raw driver handle for pragmas, health checks and backups. */
  readonly raw: BetterSqlite3.Database;
  /** Runs `fn` inside a SQLite transaction (synchronous; rolls back on throw). */
  transaction<T>(fn: (tx: AllayaDb) => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** File path, or `:memory:` for tests. */
  path: string;
  /** Directory containing drizzle-kit generated SQL migrations. */
  migrationsFolder: string;
  readonly?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  let raw: BetterSqlite3.Database;
  try {
    raw = new BetterSqlite3(options.path, { readonly: options.readonly ?? false });
  } catch (cause) {
    throw new AllayaError('Could not open the local database', { code: 'DATABASE_ERROR', cause });
  }

  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  if (options.path !== ':memory:') {
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
  }

  const db = drizzle(raw, { schema });

  if (!options.readonly) {
    try {
      migrate(db, { migrationsFolder: options.migrationsFolder });
    } catch (cause) {
      raw.close();
      throw new AllayaError('Database migration failed', { code: 'DATABASE_ERROR', cause });
    }
  }

  return {
    db,
    raw,
    transaction: (fn) => db.transaction((tx) => fn(tx as unknown as AllayaDb)),
    close: () => raw.close(),
  };
}

export interface DatabaseHealth {
  ok: boolean;
  schemaVersion: number;
  foreignKeys: boolean;
  journalMode: string;
  tableCount: number;
  error?: string;
}

export function checkDatabaseHealth(handle: DatabaseHandle): DatabaseHealth {
  try {
    const integrity = handle.raw.pragma('integrity_check', { simple: true });
    const foreignKeys = handle.raw.pragma('foreign_keys', { simple: true }) === 1;
    const journalMode = String(handle.raw.pragma('journal_mode', { simple: true }));
    const tableCount = (
      handle.raw
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get() as { n: number }
    ).n;
    const migrations = handle.raw
      .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
      .get() as { n: number };
    return {
      ok: integrity === 'ok',
      schemaVersion: migrations.n,
      foreignKeys,
      journalMode,
      tableCount,
    };
  } catch (error) {
    return {
      ok: false,
      schemaVersion: 0,
      foreignKeys: false,
      journalMode: 'unknown',
      tableCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
