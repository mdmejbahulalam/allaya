import type { MemoryRepository, MemoryRow } from '@allaya/database';
import type { MemoryRecord, MemoryStore } from '@allaya/memory';
import { MEMORY_CATEGORIES, MEMORY_SOURCES } from '@allaya/types';

const category = (value: string): MemoryRecord['category'] =>
  (MEMORY_CATEGORIES as readonly string[]).includes(value)
    ? (value as MemoryRecord['category'])
    : 'facts';
const source = (value: string): MemoryRecord['source'] =>
  (MEMORY_SOURCES as readonly string[]).includes(value)
    ? (value as MemoryRecord['source'])
    : 'system';

const fromRow = (row: MemoryRow): MemoryRecord => ({
  id: row.id,
  category: category(row.category),
  key: row.key,
  value: row.value,
  source: source(row.source),
  ...(row.origin === 'screen' || row.origin === 'chat' ? { origin: row.origin } : {}),
  useCount: row.useCount,
  ...(row.lastUsedAt !== null ? { lastUsedAt: row.lastUsedAt } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** SQLite-backed memories. Unknown categories or sources in a damaged row degrade to safe values, never crash. */
export class DbMemoryStore implements MemoryStore {
  constructor(private readonly repo: MemoryRepository) {}

  list(): MemoryRecord[] {
    return this.repo.list().map(fromRow);
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.repo.get(id);
    return row ? fromRow(row) : undefined;
  }

  insert(record: MemoryRecord): void {
    this.repo.insert({
      id: record.id,
      category: record.category,
      key: record.key,
      value: record.value,
      source: record.source,
      confidence: 1,
      origin: record.origin ?? null,
      useCount: record.useCount,
      lastUsedAt: record.lastUsedAt ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  update(id: string, patch: Partial<Omit<MemoryRecord, 'id' | 'createdAt'>>): MemoryRecord {
    const { origin, lastUsedAt, ...rest } = patch;
    this.repo.update(id, {
      ...rest,
      ...(origin !== undefined ? { origin } : {}),
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    });
    const row = this.repo.get(id);
    if (!row) throw new Error(`no memory ${id}`);
    return fromRow(row);
  }

  remove(id: string): void {
    this.repo.remove(id);
  }

  removeAll(): number {
    return this.repo.removeAll();
  }

  touch(ids: readonly string[], at: number): void {
    this.repo.touch(ids, at);
  }
}
