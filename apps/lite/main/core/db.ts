import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * The schema, as a list of steps. A database remembers how many it has had (`user_version`), so a new version of the
 * app only runs the steps it has not seen. Never edit a step that has shipped; add another.
 */
const MIGRATIONS: readonly string[] = [
  `
  create table settings (key text primary key, value text not null);

  create table secrets (name text primary key, enc text not null, hint text not null);

  create table connections (
    id text primary key,
    preset_id text,
    kind text not null,
    name text not null,
    base_url text,
    manual_models text not null default '[]',
    created_at integer not null
  );

  create table chats (
    id text primary key,
    title text not null,
    model_json text,
    created_at integer not null,
    updated_at integer not null
  );

  create table messages (
    id text primary key,
    chat_id text not null references chats(id) on delete cascade,
    role text not null,
    content text not null,
    status text not null,
    model text,
    error_json text,
    steps_json text,
    created_at integer not null
  );
  create index messages_by_chat on messages (chat_id);
  `,
  `
  create table tasks (
    id text primary key,
    title text not null,
    instructions text not null,
    model_json text,
    schedule_json text not null,
    groups_json text not null,
    enabled integer not null default 1,
    next_run_at integer,
    created_by text not null,
    created_at integer not null,
    updated_at integer not null
  );

  create table task_runs (
    id text primary key,
    task_id text not null references tasks(id) on delete cascade,
    trigger text not null,
    status text not null,
    model text not null,
    result text not null default '',
    error_json text,
    steps_json text,
    started_at integer not null,
    finished_at integer
  );
  create index task_runs_by_task on task_runs (task_id, started_at);
  `,
  `
  create table mcp_servers (
    id text primary key,
    name text not null,
    preset_id text,
    transport text not null,
    url text,
    command text,
    args_json text not null default '[]',
    auth text not null,
    trust_hints integer not null default 0,
    enabled integer not null default 1,
    created_at integer not null
  );

  create table mcp_tool_prefs (
    server_id text not null references mcp_servers(id) on delete cascade,
    tool text not null,
    ask integer,
    enabled integer,
    primary key (server_id, tool)
  );
  `,
];

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const have = Number(db.pragma('user_version', { simple: true }));
  for (let version = have; version < MIGRATIONS.length; version += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
