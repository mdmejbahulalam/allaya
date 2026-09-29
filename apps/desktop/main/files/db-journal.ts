import type { FileOperationRepository, FileOperationRow } from '@allaya/database';
import type { JournalEntry, JournalKind, JournalStore, UndoData } from '@allaya/filesystem';

const KINDS: readonly JournalKind[] = [
  'create_file',
  'create_folder',
  'overwrite',
  'copy',
  'move',
  'trash',
];

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Undo data comes from the database, so it is checked for shape (paths are re-validated again at undo time). */
function parseData(json: string | null): UndoData | undefined {
  if (!json) return undefined;
  try {
    const data = JSON.parse(json) as Record<string, unknown>;
    const str = (key: string) => typeof data[key] === 'string';
    const num = (key: string) => typeof data[key] === 'number';
    switch (data['type']) {
      case 'create_file':
        return str('path') && num('size') && num('mtimeMs') ? (data as UndoData) : undefined;
      case 'create_folder':
        return isStringArray(data['paths']) ? (data as UndoData) : undefined;
      case 'overwrite':
        return str('path') && str('backupId') && num('size') && num('mtimeMs')
          ? (data as UndoData)
          : undefined;
      case 'copy':
        return str('path') && typeof data['isDirectory'] === 'boolean' && str('fingerprint')
          ? (data as UndoData)
          : undefined;
      case 'move':
        return str('from') && str('to') ? (data as UndoData) : undefined;
      case 'trash':
        return str('path') && str('restoreId') ? (data as UndoData) : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function toEntry(row: FileOperationRow): JournalEntry {
  const data = parseData(row.dataJson);
  const kind = KINDS.includes(row.kind as JournalKind) ? (row.kind as JournalKind) : 'create_file';
  return {
    id: row.id,
    createdAt: row.createdAt,
    kind,
    label: row.label,
    target: row.target ?? undefined,
    // An entry whose data cannot be read back can never be undone.
    undoable: row.undoable && data !== undefined,
    note: row.note ?? undefined,
    undoneAt: row.undoneAt ?? undefined,
    data,
  };
}

/** The undo journal, kept in the database so an undo still works after Allaya restarts. */
export class DbJournal implements JournalStore {
  constructor(
    private readonly repo: FileOperationRepository,
    private readonly onChange: (entry?: JournalEntry) => void = () => undefined,
  ) {}

  add(entry: JournalEntry): void {
    this.repo.add({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      target: entry.target ?? null,
      undoable: entry.undoable,
      note: entry.note ?? null,
      dataJson: entry.data ? JSON.stringify(entry.data) : null,
      createdAt: entry.createdAt,
    });
    this.onChange(entry);
  }

  get(id: string): JournalEntry | undefined {
    const row = this.repo.get(id);
    return row ? toEntry(row) : undefined;
  }

  list(limit: number): JournalEntry[] {
    return this.repo.list(limit).map(toEntry);
  }

  markUndone(id: string, at: number): void {
    this.repo.markUndone(id, at);
    this.onChange();
  }
}
