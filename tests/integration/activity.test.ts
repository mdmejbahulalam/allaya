import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolAuditRepository, schema } from '@allaya/database';
import type { ActivityList } from '@allaya/validation';
import { API_KEY } from '../helpers/anthropic';
import { createTestBackend, type TestBackend } from '../helpers/backend';
import { aiCall, aiTurn, fakeAi, type FakeAiScript } from '../helpers/fake-ai';

const backends: TestBackend[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const DAY = 86_400_000;

function boot(script: FakeAiScript = {}, databasePath?: string) {
  const ai = fakeAi(script);
  const backend = createTestBackend({ fetch: ai.fetch, ...(databasePath ? { databasePath } : {}) });
  backends.push(backend);
  return { backend, ai };
}
const list = async (b: TestBackend, request?: Record<string, unknown>) =>
  data<ActivityList>(await b.call('activity:list', request));

/** Writes one finished call straight into the record, at a chosen time. */
function record(
  b: TestBackend,
  n: number,
  over: {
    at: number;
    tool?: string;
    summary?: string;
    result?: string;
    risk?: string;
    inflight?: boolean;
  },
) {
  const repo = new ToolAuditRepository(b.container.database.db, () => over.at);
  const id = `call_${n}`;
  repo.begin({
    id,
    toolName: over.tool ?? 'get_datetime',
    argumentsJson: '{}',
    risk: over.risk ?? 'LOW',
    summary: over.summary ?? `Did thing ${n}`,
  });
  if (over.inflight) return id;
  repo.finish({
    id,
    toolName: over.tool ?? 'get_datetime',
    summary: over.summary ?? `Did thing ${n}`,
    risk: over.risk ?? 'LOW',
    permissionDecision: 'not_required',
    status: 'success',
    ok: true,
    activityResult: over.result ?? 'success',
    startedAt: over.at,
    completedAt: over.at,
  });
  return id;
}

describe('the Activity record', () => {
  it('starts empty and says how long entries are kept', async () => {
    const { backend } = boot();
    expect(await list(backend)).toEqual({ entries: [], hasMore: false, retentionDays: 90 });
  });

  it('records what the AI did through the real pipeline, and announces it', async () => {
    const { backend } = boot({
      chat: [aiTurn(aiCall('get_datetime', {})), { text: ['It is now.'] }],
    });
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
    await backend.call('chat:send', { text: 'what time is it' });
    await vi.waitFor(async () => expect((await list(backend)).entries).toHaveLength(1), {
      timeout: 5000,
    });
    const [entry] = (await list(backend)).entries;
    expect(entry).toMatchObject({
      actor: 'allaya',
      tool: 'get_datetime',
      result: 'success',
      risk: 'LOW',
    });
    expect(entry!.timestamp).toBeGreaterThan(0);
    expect(backend.eventsOf('activity:changed').length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(backend.container.runs.active()).toEqual([]), { timeout: 5000 });
  });

  it('pages newest first, saying whether there is more', async () => {
    const { backend } = boot();
    for (let i = 1; i <= 5; i += 1) record(backend, i, { at: 1000 * i });
    const first = await list(backend, { limit: 2 });
    expect(first.entries.map((e) => e.action)).toEqual(['Did thing 5', 'Did thing 4']);
    expect(first.hasMore).toBe(true);
    const second = await list(backend, { limit: 2, before: first.entries.at(-1)!.timestamp });
    expect(second.entries.map((e) => e.action)).toEqual(['Did thing 3', 'Did thing 2']);
    const last = await list(backend, { limit: 2, before: second.entries.at(-1)!.timestamp });
    expect(last.entries.map((e) => e.action)).toEqual(['Did thing 1']);
    expect(last.hasMore).toBe(false);
  });

  it('narrows by result, by risk and by words — and the words are matched literally', async () => {
    const { backend } = boot();
    record(backend, 1, { at: 1000, summary: 'Read the clock', tool: 'get_datetime' });
    record(backend, 2, {
      at: 2000,
      summary: 'Delete “old.txt”',
      tool: 'delete_file',
      risk: 'HIGH',
      result: 'denied',
    });
    record(backend, 3, {
      at: 3000,
      summary: '100% done',
      tool: 'write_file',
      risk: 'MEDIUM',
      result: 'failure',
    });
    record(backend, 4, { at: 4000, summary: 'Open a_b', tool: 'open_app', risk: 'MEDIUM' });
    expect((await list(backend, { result: 'denied' })).entries.map((e) => e.tool)).toEqual([
      'delete_file',
    ]);
    expect((await list(backend, { risk: 'MEDIUM' })).entries).toHaveLength(2);
    expect((await list(backend, { risk: 'MEDIUM', result: 'failure' })).entries).toHaveLength(1);
    expect((await list(backend, { query: 'delete' })).entries).toHaveLength(1);
    expect((await list(backend, { query: 'write_file' })).entries).toHaveLength(1);
    // `%` and `_` are ordinary characters, not wildcards.
    expect((await list(backend, { query: '100%' })).entries.map((e) => e.tool)).toEqual([
      'write_file',
    ]);
    expect((await list(backend, { query: '%' })).entries.map((e) => e.tool)).toEqual([
      'write_file',
    ]);
    expect((await list(backend, { query: 'a_b' })).entries).toHaveLength(1);
    // Every tool name here has an underscore; as a wildcard it would match far more ("o_d" would find "old").
    expect((await list(backend, { query: '_' })).entries).toHaveLength(4);
    expect((await list(backend, { query: 'o_d' })).entries).toEqual([]);
    expect((await list(backend, { query: 'zzz' })).entries).toEqual([]);
  });

  it('shows only what is safe to show: no stored details, and unknown values degrade', async () => {
    const { backend } = boot();
    backend.container.database.db
      .insert(schema.activityLogs)
      .values({
        id: 'odd',
        timestamp: 5000,
        actor: 'martian',
        action: 'Odd row',
        result: 'exploded',
        risk: 'ENORMOUS',
        detailsJson: '{"secret":"do-not-show"}',
      })
      .run();
    const { entries } = await list(backend);
    expect(entries[0]).toEqual({
      id: 'odd',
      timestamp: 5000,
      actor: 'system',
      action: 'Odd row',
      result: 'info',
    });
    expect(JSON.stringify(entries)).not.toContain('do-not-show');
  });

  it('clearing removes the record, and never breaks a call that is still running', async () => {
    const { backend } = boot();
    record(backend, 1, { at: 1000 });
    record(backend, 2, { at: 2000 });
    const running = record(backend, 3, { at: 3000, inflight: true });
    expect(data<{ removed: number }>(await backend.call('activity:clear'))).toEqual({ removed: 2 });
    expect((await list(backend)).entries).toEqual([]);
    expect(backend.eventsOf('activity:changed').length).toBeGreaterThan(0);
    // The running call finishes and writes its result without error.
    const repo = new ToolAuditRepository(backend.container.database.db, () => 4000);
    expect(() =>
      repo.finish({
        id: running,
        toolName: 'get_datetime',
        summary: 'Still running',
        permissionDecision: 'not_required',
        status: 'success',
        ok: true,
        activityResult: 'success',
        startedAt: 3000,
        completedAt: 4000,
      }),
    ).not.toThrow();
    expect((await list(backend)).entries).toHaveLength(1);
  });

  it('removes entries older than the retention when Allaya starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-activity-'));
    scratch.push(dir);
    const path = join(dir, 'allaya.db');
    const first = boot({}, path);
    const now = Date.now();
    record(first.backend, 1, { at: now - 91 * DAY, summary: 'Ancient' });
    record(first.backend, 2, { at: now - 89 * DAY, summary: 'Recent' });
    first.backend.dispose();
    backends.splice(backends.indexOf(first.backend), 1);
    const second = boot({}, path);
    expect((await list(second.backend)).entries.map((e) => e.action)).toEqual(['Recent']);
  });

  it('refuses malformed requests', async () => {
    const { backend } = boot();
    for (const bad of [
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { before: -1 },
      { result: 'pending' },
      { risk: 'HUGE' },
      { query: 'x'.repeat(101) },
      { extra: true },
      'text',
      42,
      null,
    ]) {
      const result = (await backend.call('activity:list', bad)) as { ok: boolean };
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
