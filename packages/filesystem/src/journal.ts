/**
 * The undo journal: what Allaya changed, in enough detail to put it back — but only while doing so cannot destroy
 * anything the user did in the meantime (a file the user edited after Allaya created it is never removed).
 */
export type JournalKind = 'create_file' | 'create_folder' | 'overwrite' | 'copy' | 'move' | 'trash';

/** What is needed to reverse the action. Absolute paths; re-validated against the roots before use. */
export type UndoData =
  | { type: 'create_file'; path: string; size: number; mtimeMs: number }
  | { type: 'create_folder'; paths: string[] }
  | { type: 'overwrite'; path: string; backupId: string; size: number; mtimeMs: number }
  | { type: 'copy'; path: string; isDirectory: boolean; fingerprint: string }
  | { type: 'move'; from: string; to: string }
  | { type: 'trash'; path: string; restoreId: string };

export interface JournalEntry {
  id: string;
  createdAt: number;
  kind: JournalKind;
  /** The path shown to the user (`Documents/report.txt`). */
  label: string;
  /** For copy/move/rename: the destination, in the same form. */
  target?: string | undefined;
  /** `false` when the action cannot be reversed by Allaya (with `note` saying why and what to do instead). */
  undoable: boolean;
  note?: string | undefined;
  undoneAt?: number | undefined;
  data?: UndoData | undefined;
}

export interface JournalStore {
  add(entry: JournalEntry): void;
  get(id: string): JournalEntry | undefined;
  /** Newest first. */
  list(limit: number): JournalEntry[];
  markUndone(id: string, at: number): void;
}

/** Keeps the journal in memory. Used by tests and as the base of the database-backed store. */
export class MemoryJournal implements JournalStore {
  private readonly entries: JournalEntry[] = [];

  add(entry: JournalEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > 200) this.entries.length = 200;
  }

  get(id: string): JournalEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  list(limit: number): JournalEntry[] {
    return this.entries.slice(0, limit).map((entry) => ({ ...entry }));
  }

  markUndone(id: string, at: number): void {
    const entry = this.get(id);
    if (entry) entry.undoneAt = at;
  }
}

/** The newest entry that can still be undone. */
export function latestUndoable(store: JournalStore): JournalEntry | undefined {
  return store.list(50).find((entry) => entry.undoable && entry.undoneAt === undefined);
}
