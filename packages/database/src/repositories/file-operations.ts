import { desc, eq } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { fileOperations } from '../schema';

export interface FileOperationRow {
  id: string;
  kind: string;
  label: string;
  target: string | null;
  undoable: boolean;
  note: string | null;
  dataJson: string | null;
  createdAt: number;
  undoneAt: number | null;
}

const KEEP = 200;

/** Raw persistence of the file-undo journal. Meaning and validation live in the desktop app's journal adapter. */
export class FileOperationRepository {
  constructor(private readonly db: AllayaDb) {}

  add(row: Omit<FileOperationRow, 'undoneAt'>): void {
    this.db.insert(fileOperations).values(row).run();
    // Keep the journal bounded: the oldest entries fall off. (Read the ids and cut in code: SQLite needs a LIMIT
    // before an OFFSET, and this set is only a couple of hundred rows.)
    const ids = this.db
      .select({ id: fileOperations.id })
      .from(fileOperations)
      .orderBy(desc(fileOperations.createdAt), desc(fileOperations.id))
      .all();
    for (const { id } of ids.slice(KEEP)) {
      this.db.delete(fileOperations).where(eq(fileOperations.id, id)).run();
    }
  }

  get(id: string): FileOperationRow | undefined {
    return this.db.select().from(fileOperations).where(eq(fileOperations.id, id)).get();
  }

  /** Newest first. */
  list(limit: number): FileOperationRow[] {
    return this.db
      .select()
      .from(fileOperations)
      .orderBy(desc(fileOperations.createdAt), desc(fileOperations.id))
      .limit(limit)
      .all();
  }

  markUndone(id: string, at: number): void {
    this.db.update(fileOperations).set({ undoneAt: at }).where(eq(fileOperations.id, id)).run();
  }
}
