import { eq } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { settings } from '../schema';

/** Raw key/value persistence. Validation against the settings registry happens in the service layer. */
export class SettingsRepository {
  constructor(
    private readonly db: AllayaDb,
    private readonly now: () => number = Date.now,
  ) {}

  getAll(): Map<string, unknown> {
    const rows = this.db.select().from(settings).all();
    const out = new Map<string, unknown>();
    for (const row of rows) {
      try {
        out.set(row.key, JSON.parse(row.valueJson));
      } catch {
        // Corrupt row: ignore so defaults apply rather than crashing startup.
      }
    }
    return out;
  }

  set(key: string, value: unknown): void {
    const valueJson = JSON.stringify(value);
    const updatedAt = this.now();
    this.db
      .insert(settings)
      .values({ key, valueJson, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt } })
      .run();
  }

  delete(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}
