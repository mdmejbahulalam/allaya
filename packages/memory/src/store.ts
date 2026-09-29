import type { MemoryCategory, MemorySource } from '@allaya/types';

export type MemoryOrigin = 'screen' | 'chat';

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  source: MemorySource;
  origin?: MemoryOrigin | undefined;
  useCount: number;
  lastUsedAt?: number | undefined;
  createdAt: number;
  updatedAt: number;
}

/** Where memories live. The app uses SQLite; tests use `MemoryMemoryStore`. */
export interface MemoryStore {
  /** Oldest first. */
  list(): MemoryRecord[];
  get(id: string): MemoryRecord | undefined;
  insert(record: MemoryRecord): void;
  update(id: string, patch: Partial<Omit<MemoryRecord, 'id' | 'createdAt'>>): MemoryRecord;
  remove(id: string): void;
  removeAll(): number;
  /** Counts one use for each memory. */
  touch(ids: readonly string[], at: number): void;
}

export class MemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();

  list(): MemoryRecord[] {
    return [...this.records.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  get(id: string): MemoryRecord | undefined {
    const found = this.records.get(id);
    return found ? { ...found } : undefined;
  }

  insert(record: MemoryRecord): void {
    this.records.set(record.id, { ...record });
  }

  update(id: string, patch: Partial<Omit<MemoryRecord, 'id' | 'createdAt'>>): MemoryRecord {
    const current = this.records.get(id);
    if (!current) throw new Error(`no memory ${id}`);
    const next = { ...current, ...patch };
    this.records.set(id, next);
    return { ...next };
  }

  remove(id: string): void {
    this.records.delete(id);
  }

  removeAll(): number {
    const n = this.records.size;
    this.records.clear();
    return n;
  }

  touch(ids: readonly string[], at: number): void {
    for (const id of ids) {
      const record = this.records.get(id);
      if (record) {
        record.useCount += 1;
        record.lastUsedAt = at;
      }
    }
  }
}
