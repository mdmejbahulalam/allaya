import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { conversations, messages } from '../schema';

export interface ConversationRow {
  id: string;
  title: string;
  language: string | null;
  modelId: string | null;
  pinned: boolean;
  summary: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  kind: string;
  content: string;
  language: string | null;
  taskId: string | null;
  metadataJson: string | null;
  createdAt: number;
}

const conversationColumns = {
  id: conversations.id,
  title: conversations.title,
  language: conversations.language,
  modelId: conversations.modelId,
  pinned: conversations.pinned,
  summary: conversations.summary,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};

export class ConversationRepository {
  constructor(
    private readonly db: AllayaDb,
    private readonly now: () => number = Date.now,
  ) {}

  create(id: string, title: string): ConversationRow {
    const at = this.now();
    this.db.insert(conversations).values({ id, title, createdAt: at, updatedAt: at }).run();
    return this.get(id)!;
  }

  get(id: string): ConversationRow | undefined {
    return this.db
      .select(conversationColumns)
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .get();
  }

  /** Pinned first, then most recently updated. Soft-deleted conversations are excluded. */
  list(limit = 200): ConversationRow[] {
    return this.db
      .select(conversationColumns)
      .from(conversations)
      .where(isNull(conversations.deletedAt))
      .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
      .limit(limit)
      .all();
  }

  rename(id: string, title: string): void {
    this.db
      .update(conversations)
      .set({ title, updatedAt: this.now() })
      .where(eq(conversations.id, id))
      .run();
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.update(conversations).set({ pinned }).where(eq(conversations.id, id)).run();
  }

  setModel(id: string, modelId: string | null): void {
    this.db.update(conversations).set({ modelId }).where(eq(conversations.id, id)).run();
  }

  setSummary(id: string, summary: string, throughMessageId: string): void {
    this.db
      .update(conversations)
      .set({ summary, summarizedThroughMessageId: throughMessageId })
      .where(eq(conversations.id, id))
      .run();
  }

  touch(id: string): void {
    this.db
      .update(conversations)
      .set({ updatedAt: this.now() })
      .where(eq(conversations.id, id))
      .run();
  }

  /** Soft delete: recoverable, and messages are retained until purged. */
  softDelete(id: string): void {
    this.db
      .update(conversations)
      .set({ deletedAt: this.now() })
      .where(eq(conversations.id, id))
      .run();
  }

  /** Permanent removal (cascades to messages). Used by "delete all data". */
  purge(id: string): void {
    this.db.delete(conversations).where(eq(conversations.id, id)).run();
  }

  // ── messages ──────────────────────────────────────────────────────────────
  addMessage(input: {
    id: string;
    conversationId: string;
    kind: string;
    content: string;
    language?: string | null;
    taskId?: string | null;
    metadata?: unknown;
  }): MessageRow {
    const at = this.now();
    this.db
      .insert(messages)
      .values({
        id: input.id,
        conversationId: input.conversationId,
        kind: input.kind,
        content: input.content,
        language: input.language ?? null,
        taskId: input.taskId ?? null,
        metadataJson: input.metadata === undefined ? null : JSON.stringify(input.metadata),
        createdAt: at,
      })
      .run();
    this.touch(input.conversationId);
    return this.getMessage(input.id)!;
  }

  getMessage(id: string): MessageRow | undefined {
    return this.db.select().from(messages).where(eq(messages.id, id)).get();
  }

  updateMessage(id: string, patch: { content?: string; metadata?: unknown }): void {
    this.db
      .update(messages)
      .set({
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.metadata !== undefined ? { metadataJson: JSON.stringify(patch.metadata) } : {}),
      })
      .where(eq(messages.id, id))
      .run();
  }

  /** Chronological. `rowid` (insertion order) breaks ties between messages created in the same millisecond. */
  listMessages(conversationId: string): MessageRow[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(sql`rowid`))
      .all();
  }
}
