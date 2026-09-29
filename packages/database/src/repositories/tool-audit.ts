import { and, desc, eq, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AllayaDb } from '../connection';
import { activityLogs, toolCalls, toolResults } from '../schema';

export interface ToolCallStart {
  id: string;
  taskId?: string | undefined;
  toolName: string;
  /** Already redacted. */
  argumentsJson: string;
  risk: string;
  summary: string;
}

export interface ToolCallFinish {
  id: string;
  taskId?: string | undefined;
  toolName: string;
  summary: string;
  risk?: string | undefined;
  permissionDecision: string;
  status: string;
  ok: boolean;
  outputJson?: string | undefined;
  verificationJson?: string | undefined;
  errorJson?: string | undefined;
  error?: string | undefined;
  /** `success` | `failure` | `denied` | `cancelled` */
  activityResult: string;
  startedAt: number;
  completedAt: number;
  detailsJson?: string | undefined;
}

export interface ActivityRow {
  id: string;
  timestamp: number;
  actor: string;
  tool: string | null;
  action: string;
  result: string;
  risk: string | null;
  permission: string | null;
  error: string | null;
  detailsJson: string | null;
}

/** The audit trail of everything Allaya tried to do: a call record, its result, and a readable activity entry. */
export class ToolAuditRepository {
  constructor(
    private readonly db: AllayaDb,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID(),
    /** Called after each call is recorded (so a screen showing the record can refresh). */
    private readonly onRecorded?: () => void,
  ) {}

  begin(entry: ToolCallStart): void {
    this.db
      .insert(toolCalls)
      .values({
        id: entry.id,
        taskId: entry.taskId ?? null,
        toolName: entry.toolName,
        argumentsJson: entry.argumentsJson,
        risk: entry.risk,
        permissionDecision: 'not_required',
        status: 'pending',
        startedAt: this.now(),
      })
      .run();
  }

  finish(entry: ToolCallFinish): void {
    this.db.transaction((tx) => {
      tx.update(toolCalls)
        .set({
          permissionDecision: entry.permissionDecision,
          status: entry.status,
          ...(entry.risk ? { risk: entry.risk } : {}),
          startedAt: entry.startedAt,
          completedAt: entry.completedAt,
        })
        .where(eq(toolCalls.id, entry.id))
        .run();
      tx.insert(toolResults)
        .values({
          id: this.newId(),
          toolCallId: entry.id,
          ok: entry.ok,
          outputJson: entry.outputJson ?? null,
          verificationJson: entry.verificationJson ?? null,
          errorJson: entry.errorJson ?? null,
        })
        .onConflictDoNothing()
        .run();
      tx.insert(activityLogs)
        .values({
          id: this.newId(),
          timestamp: entry.completedAt,
          actor: 'allaya',
          taskId: entry.taskId ?? null,
          tool: entry.toolName,
          action: entry.summary || entry.toolName,
          result: entry.activityResult,
          risk: entry.risk ?? null,
          permission: entry.permissionDecision,
          error: entry.error ?? null,
          detailsJson: entry.detailsJson ?? null,
        })
        .run();
    });
    try {
      this.onRecorded?.();
    } catch {
      /* a screen that cannot refresh must never fail the audit */
    }
  }

  recentActivity(limit = 100): ActivityRow[] {
    return this.db
      .select({
        id: activityLogs.id,
        timestamp: activityLogs.timestamp,
        actor: activityLogs.actor,
        tool: activityLogs.tool,
        action: activityLogs.action,
        result: activityLogs.result,
        risk: activityLogs.risk,
        permission: activityLogs.permission,
        error: activityLogs.error,
        detailsJson: activityLogs.detailsJson,
      })
      .from(activityLogs)
      .orderBy(desc(activityLogs.timestamp), desc(activityLogs.id))
      .limit(limit)
      .all();
  }

  /**
   * A page of the record, newest first, optionally narrowed. Asks for one more than `limit` to know whether there is
   * more. Search words are matched literally (`%` and `_` in them are not wildcards).
   */
  activity(filter: {
    limit: number;
    before?: number | undefined;
    result?: string | undefined;
    risk?: string | undefined;
    query?: string | undefined;
  }): { entries: ActivityRow[]; hasMore: boolean } {
    const conditions: SQL[] = [];
    if (filter.before !== undefined) conditions.push(lt(activityLogs.timestamp, filter.before));
    if (filter.result) conditions.push(eq(activityLogs.result, filter.result));
    if (filter.risk) conditions.push(eq(activityLogs.risk, filter.risk));
    const words = (filter.query ?? '').trim();
    if (words) {
      const pattern = `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const match = or(
        sql`${activityLogs.action} like ${pattern} escape '\\'`,
        sql`${activityLogs.tool} like ${pattern} escape '\\'`,
      );
      if (match) conditions.push(match);
    }
    const rows = this.db
      .select({
        id: activityLogs.id,
        timestamp: activityLogs.timestamp,
        actor: activityLogs.actor,
        tool: activityLogs.tool,
        action: activityLogs.action,
        result: activityLogs.result,
        risk: activityLogs.risk,
        permission: activityLogs.permission,
        error: activityLogs.error,
        detailsJson: activityLogs.detailsJson,
      })
      .from(activityLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(activityLogs.timestamp), desc(activityLogs.id))
      .limit(filter.limit + 1)
      .all();
    return { entries: rows.slice(0, filter.limit), hasMore: rows.length > filter.limit };
  }

  /** Removes the whole record (activity lines and the call records behind them). Returns how many lines went. */
  clear(): number {
    return this.db.transaction((tx) => {
      const removed = tx.delete(activityLogs).run().changes;
      // Calls still in flight keep their rows: they are about to write their result against them.
      tx.delete(toolCalls).where(isNotNull(toolCalls.completedAt)).run();
      return removed;
    });
  }

  /** Removes what is older than `cutoff` (epoch ms). Returns how many activity lines went. */
  pruneOlderThan(cutoff: number): number {
    return this.db.transaction((tx) => {
      const removed = tx
        .delete(activityLogs)
        .where(lt(activityLogs.timestamp, cutoff))
        .run().changes;
      tx.delete(toolCalls)
        .where(and(isNotNull(toolCalls.completedAt), lt(toolCalls.completedAt, cutoff)))
        .run();
      return removed;
    });
  }

  getCall(id: string) {
    return this.db.select().from(toolCalls).where(eq(toolCalls.id, id)).get();
  }

  getResult(toolCallId: string) {
    return this.db.select().from(toolResults).where(eq(toolResults.toolCallId, toolCallId)).get();
  }
}
