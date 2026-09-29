import type { ActivityRow, ToolAuditRepository } from '@allaya/database';
import { RISK_LEVELS } from '@allaya/types';
import type { ActivityEntry } from '@allaya/validation';
import type { HandlerRegistry } from '../registry';

export const ACTIVITY_RETENTION_DAYS = 90;
const DEFAULT_PAGE = 50;

const RESULTS = ['success', 'failure', 'denied', 'cancelled', 'pending', 'info'] as const;
const ACTORS = ['allaya', 'user', 'system'] as const;

/** A stored row as the screen may see it: known values only, and never the raw structured details. */
export function toEntry(row: ActivityRow): ActivityEntry {
  const risk = (RISK_LEVELS as readonly string[]).includes(row.risk ?? '')
    ? (row.risk as ActivityEntry['risk'])
    : undefined;
  return {
    id: row.id,
    timestamp: row.timestamp,
    actor: (ACTORS as readonly string[]).includes(row.actor)
      ? (row.actor as ActivityEntry['actor'])
      : 'system',
    ...(row.tool ? { tool: row.tool } : {}),
    action: row.action,
    result: (RESULTS as readonly string[]).includes(row.result)
      ? (row.result as ActivityEntry['result'])
      : 'info',
    ...(risk ? { risk } : {}),
    ...(row.permission ? { permission: row.permission } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export function registerActivityHandlers(
  registry: HandlerRegistry,
  audit: ToolAuditRepository,
  changed: () => void,
): void {
  registry
    .register('activity:list', (request) => {
      const page = audit.activity({
        limit: request?.limit ?? DEFAULT_PAGE,
        before: request?.before,
        result: request?.result,
        risk: request?.risk,
        query: request?.query,
      });
      return {
        entries: page.entries.map(toEntry),
        hasMore: page.hasMore,
        retentionDays: ACTIVITY_RETENTION_DAYS,
      };
    })
    .register('activity:clear', () => {
      const removed = audit.clear();
      changed();
      return { removed };
    });
}
