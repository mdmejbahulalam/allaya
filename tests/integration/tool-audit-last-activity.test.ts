import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolAuditRepository,
  openDatabase,
  sourceMigrationsFolder,
  type DatabaseHandle,
} from '@allaya/database';

let handle: DatabaseHandle;
afterEach(() => handle?.close());

function repoWith(rows: Array<{ tool: string; summary: string; result: string; at: number }>) {
  handle = openDatabase({ path: ':memory:', migrationsFolder: sourceMigrationsFolder() });
  let clock = 0;
  const repo = new ToolAuditRepository(handle.db, () => clock);
  rows.forEach((row, n) => {
    clock = row.at;
    const id = `c${n}`;
    repo.begin({
      id,
      toolName: row.tool,
      argumentsJson: '{}',
      risk: 'LOW',
      summary: row.summary,
    });
    repo.finish({
      id,
      toolName: row.tool,
      summary: row.summary,
      risk: 'LOW',
      permissionDecision: 'not_required',
      status: row.result === 'success' ? 'success' : 'failed',
      ok: row.result === 'success',
      activityResult: row.result,
      startedAt: row.at,
      completedAt: row.at,
    });
  });
  return repo;
}

describe('lastActivityAt (when Allaya last used an app)', () => {
  it('returns the newest successful use, from the named tools only', () => {
    const repo = repoWith([
      { tool: 'open_app', summary: 'Opened Chrome', result: 'success', at: 100 },
      { tool: 'close_app', summary: 'Closed Chrome', result: 'success', at: 200 },
      { tool: 'get_datetime', summary: 'Chrome mentioned', result: 'success', at: 300 },
    ]);
    expect(repo.lastActivityAt(['open_app', 'close_app'], 'Chrome')).toBe(200);
    expect(repo.lastActivityAt(['open_app', 'close_app'], 'Edge')).toBeUndefined();
  });

  it('a failed, denied or cancelled attempt is not a use', () => {
    const repo = repoWith([
      { tool: 'open_app', summary: 'Opened Chrome', result: 'success', at: 100 },
      { tool: 'open_app', summary: 'Opened Chrome', result: 'failure', at: 200 },
      { tool: 'open_app', summary: 'Opened Chrome', result: 'denied', at: 300 },
      { tool: 'open_app', summary: 'Opened Chrome', result: 'cancelled', at: 400 },
    ]);
    expect(repo.lastActivityAt(['open_app'], 'Chrome')).toBe(100);
  });

  it('matches the name literally: % and _ are not wildcards', () => {
    const repo = repoWith([
      { tool: 'open_app', summary: 'Opened Chrome', result: 'success', at: 100 },
    ]);
    expect(repo.lastActivityAt(['open_app'], '%')).toBeUndefined();
    expect(repo.lastActivityAt(['open_app'], 'Chr_me')).toBeUndefined();
    expect(repo.lastActivityAt(['open_app'], 'Chr%')).toBeUndefined();
  });
});
