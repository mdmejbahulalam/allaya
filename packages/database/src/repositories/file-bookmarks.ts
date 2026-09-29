import { and, asc, desc, eq } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { fileBookmarks } from '../schema';

export type BookmarkKind = 'quick_location' | 'recent' | 'user';

export interface BookmarkRow {
  id: string;
  label: string;
  path: string;
  kind: string;
  lastAccessedAt: number | null;
  createdAt: number;
}

const MAX_RECENT = 20;

/** Folders the user added, and files Allaya recently worked with. */
export class FileBookmarkRepository {
  constructor(
    private readonly db: AllayaDb,
    private readonly now: () => number = Date.now,
  ) {}

  list(kind: BookmarkKind): BookmarkRow[] {
    const query = this.db.select().from(fileBookmarks).where(eq(fileBookmarks.kind, kind));
    return kind === 'recent'
      ? query.orderBy(desc(fileBookmarks.lastAccessedAt)).all()
      : query.orderBy(asc(fileBookmarks.createdAt)).all();
  }

  /** Adds a user folder. Returns `undefined` if that path is already bookmarked. */
  addUserFolder(id: string, label: string, path: string): BookmarkRow | undefined {
    const inserted = this.db
      .insert(fileBookmarks)
      .values({ id, label, path, kind: 'user', createdAt: this.now() })
      .onConflictDoNothing()
      .returning()
      .get();
    return inserted;
  }

  removeUserFolder(id: string): boolean {
    const removed = this.db
      .delete(fileBookmarks)
      .where(and(eq(fileBookmarks.id, id), eq(fileBookmarks.kind, 'user')))
      .returning({ id: fileBookmarks.id })
      .all();
    return removed.length > 0;
  }

  /** Records that a file was worked with; keeps only the newest few. */
  touchRecent(id: string, label: string, path: string): void {
    const at = this.now();
    this.db
      .insert(fileBookmarks)
      .values({ id, label, path, kind: 'recent', lastAccessedAt: at, createdAt: at })
      .onConflictDoUpdate({ target: fileBookmarks.path, set: { lastAccessedAt: at, label } })
      .run();
    const recent = this.db
      .select({ id: fileBookmarks.id })
      .from(fileBookmarks)
      .where(eq(fileBookmarks.kind, 'recent'))
      .orderBy(desc(fileBookmarks.lastAccessedAt), desc(fileBookmarks.id))
      .all();
    for (const row of recent.slice(MAX_RECENT)) {
      this.db.delete(fileBookmarks).where(eq(fileBookmarks.id, row.id)).run();
    }
  }

  clearRecent(): void {
    this.db.delete(fileBookmarks).where(eq(fileBookmarks.kind, 'recent')).run();
  }
}
