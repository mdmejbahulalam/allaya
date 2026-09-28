import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDatabaseHealth,
  eq,
  openDatabase,
  schema,
  sourceMigrationsFolder,
  type DatabaseHandle,
} from '@allaya/database';

let handle: DatabaseHandle | undefined;
const open = () =>
  (handle = openDatabase({ path: ':memory:', migrationsFolder: sourceMigrationsFolder() }));
afterEach(() => handle?.close());

describe('database', () => {
  it('applies migrations and creates every required table', () => {
    const h = open();
    const names = (
      h.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const table of [
      'users',
      'settings',
      'conversations',
      'messages',
      'tasks',
      'task_steps',
      'task_events',
      'tool_calls',
      'tool_results',
      'memories',
      'providers',
      'models',
      'api_credentials',
      'permissions',
      'automations',
      'automation_steps',
      'automation_runs',
      'activity_logs',
      'notifications',
      'installed_apps',
      'file_bookmarks',
      'voice_settings',
      'language_settings',
    ]) {
      expect(names, `missing table ${table}`).toContain(table);
    }
    expect(checkDatabaseHealth(h)).toMatchObject({ ok: true, foreignKeys: true });
  });

  it('enforces foreign keys and cascades deletes', () => {
    const { db } = open();
    expect(() =>
      db
        .insert(schema.messages)
        .values({ id: 'm1', conversationId: 'missing', kind: 'user', content: 'x' })
        .run(),
    ).toThrow(/FOREIGN KEY/i);

    db.insert(schema.conversations).values({ id: 'c1', title: 'hello' }).run();
    db.insert(schema.messages)
      .values({ id: 'm1', conversationId: 'c1', kind: 'user', content: 'hi' })
      .run();
    db.delete(schema.conversations).where(eq(schema.conversations.id, 'c1')).run();
    expect(db.select().from(schema.messages).all()).toHaveLength(0);
  });

  it('rolls back a failed transaction atomically', () => {
    const h = open();
    expect(() =>
      h.transaction((tx) => {
        tx.insert(schema.settings).values({ key: 'a', valueJson: '1' }).run();
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(h.db.select().from(schema.settings).all()).toHaveLength(0);
  });

  it('enforces uniqueness for memories (category,key)', () => {
    const { db } = open();
    db.insert(schema.memories)
      .values({ id: '1', category: 'preferences', key: 'theme', value: 'dark' })
      .run();
    expect(() =>
      db
        .insert(schema.memories)
        .values({ id: '2', category: 'preferences', key: 'theme', value: 'light' })
        .run(),
    ).toThrow(/UNIQUE/i);
  });
});
