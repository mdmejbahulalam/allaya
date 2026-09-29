import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { memories } from '../schema';

export interface MemoryRow {
  id: string;
  category: string;
  key: string;
  value: string;
  source: string;
  confidence: number;
  origin: string | null;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const columns = {
  id: memories.id,
  category: memories.category,
  key: memories.key,
  value: memories.value,
  source: memories.source,
  confidence: memories.confidence,
  origin: memories.origin,
  useCount: memories.useCount,
  lastUsedAt: memories.lastUsedAt,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
};

/** Raw persistence of what Allaya remembers. Meaning, limits and the secret check live in `@allaya/memory`. */
export class MemoryRepository {
  constructor(private readonly db: AllayaDb) {}

  insert(row: MemoryRow): void {
    this.db.insert(memories).values(row).run();
  }

  get(id: string): MemoryRow | undefined {
    return this.db.select(columns).from(memories).where(eq(memories.id, id)).get();
  }

  /** Oldest first, so the list keeps its order as things are added. */
  list(): MemoryRow[] {
    return this.db
      .select(columns)
      .from(memories)
      .orderBy(asc(memories.createdAt), asc(memories.id))
      .all();
  }

  count(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(memories)
        .get()?.n ?? 0
    );
  }

  update(id: string, patch: Partial<Omit<MemoryRow, 'id' | 'createdAt'>>): void {
    this.db.update(memories).set(patch).where(eq(memories.id, id)).run();
  }

  /** Counts a use for each memory (one statement, so a reply's memories are marked together). */
  touch(ids: readonly string[], at: number): void {
    if (ids.length === 0) return;
    this.db
      .update(memories)
      .set({ useCount: sql`${memories.useCount} + 1`, lastUsedAt: at })
      .where(inArray(memories.id, [...ids]))
      .run();
  }

  remove(id: string): void {
    this.db.delete(memories).where(eq(memories.id, id)).run();
  }

  /** Removes everything and returns how many were there. */
  removeAll(): number {
    return this.db.delete(memories).run().changes;
  }
}
