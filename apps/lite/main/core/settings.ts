import { settingsDefaults } from '../../shared/defaults';
import { settingsSchema, type Settings } from '../../shared/ipc';
import type { Db } from './db';

/** The person's choices, one row each. A stored value that no longer fits falls back to its default. */
export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly onChange: (settings: Settings) => void = () => undefined,
  ) {}

  get(): Settings {
    const rows = this.db.prepare('select key, value from settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const stored: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        stored[row.key] = JSON.parse(row.value);
      } catch {
        /* an unreadable value is the same as no value */
      }
    }
    const out: Record<string, unknown> = { ...settingsDefaults };
    for (const key of Object.keys(settingsDefaults) as Array<keyof Settings>) {
      if (!(key in stored)) continue;
      // A setting that grew a field since it was saved keeps what was saved and takes the default for the rest.
      const saved =
        key === 'voice' && typeof stored[key] === 'object' && stored[key] !== null
          ? { ...settingsDefaults.voice, ...stored[key] }
          : stored[key];
      const field = settingsSchema.shape[key].safeParse(saved);
      if (field.success) out[key] = field.data;
    }
    return out as Settings;
  }

  set(changes: Partial<Settings>): Settings {
    const write = this.db.prepare(
      `insert into settings (key, value) values (?, ?)
       on conflict(key) do update set value = excluded.value`,
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) write.run(key, JSON.stringify(value));
      }
    })();
    const next = this.get();
    this.onChange(next);
    return next;
  }
}
