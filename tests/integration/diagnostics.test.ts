import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompositeAdapter, ComputerEngine, MemoryAdapter } from '@allaya/computer';
import type { Diagnostics } from '@allaya/validation';
import { scrub } from '../../apps/desktop/main/services/diagnostics-service';
import { API_KEY, modelsResponse } from '../helpers/anthropic';
import { mockFetch } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';

const backends: TestBackend[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;
const boot = (options: Parameters<typeof createTestBackend>[0] = {}) => {
  const backend = createTestBackend(options);
  backends.push(backend);
  return backend;
};
const get = async (b: TestBackend) => data<Diagnostics>(await b.call('diagnostics:get'));

describe('the Diagnostics report', () => {
  it('describes this app and the health of each part, as statuses and counts', async () => {
    const b = boot();
    const report = await get(b);
    expect(report.app).toMatchObject({ name: expect.any(String), version: expect.any(String) });
    expect(report.generatedAt).toBeGreaterThan(0);
    expect(report.database).toMatchObject({ ok: true, tone: 'ok', foreignKeys: true });
    expect(report.database.migrations).toBeGreaterThan(3);
    expect(report.providers).toMatchObject({ connected: 0, tone: 'attention' });
    expect(report.providers.items.length).toBe(report.providers.total);
    expect(report.voice).toMatchObject({ enabled: false, tone: 'off' });
    expect(report.automations).toMatchObject({ total: 0, enabled: 0, paused: false, tone: 'ok' });
    expect(report.memory).toMatchObject({ enabled: true, count: 0 });
    expect(report.updates).toMatchObject({ state: 'unsupported', tone: 'off' });
    expect(report.shell).toMatchObject({ trayAvailable: false, tone: 'attention' });
    expect(report.permissions.changed).toEqual([]);
  });

  it('follows what is true: a connected provider, changed permissions, automations, memory, the computer', async () => {
    const f = mockFetch((req) =>
      req.url.includes('/v1/models') ? modelsResponse() : new Response('{}'),
    );
    const b = boot({
      fetch: f,
      computer: {
        engine: new ComputerEngine({
          adapter: new CompositeAdapter(new MemoryAdapter({}), undefined),
          ownPid: 1,
        }),
      },
    });
    await b.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
    await b.call('permissions:set', { subject: 'clipboard', mode: 'never' });
    await b.call('permissions:set', { subject: 'camera', mode: 'never' }); // the default: not "changed"
    await b.call('automations:create', {
      name: 'A',
      instruction: 'Do it',
      trigger: { kind: 'interval', everyMinutes: 5 },
    });
    await b.call('memory:create', { category: 'facts', key: 'k', value: 'v' });
    await b.call('desktop:stopEverything');
    const report = await get(b);
    expect(report.providers).toMatchObject({ connected: 1, tone: 'ok' });
    expect(report.providers.items.find((p) => p.status === 'connected')?.models).toBeGreaterThan(0);
    expect(report.permissions.changed).toEqual([{ subject: 'clipboard', mode: 'never' }]);
    expect(report.automations).toMatchObject({
      total: 1,
      enabled: 1,
      paused: true,
      tone: 'attention',
    });
    expect(report.memory.count).toBe(1);
    expect(report.computer).toMatchObject({
      adapter: expect.stringContaining('memory'),
      tone: 'ok',
    });
    expect(report.computer.capabilities['launch']).toBe(true);
  });

  it('never carries a key, a hint of one, a message, a memory or a task', async () => {
    const f = mockFetch((req) =>
      req.url.includes('/v1/models') ? modelsResponse() : new Response('{}'),
    );
    const b = boot({ fetch: f });
    await b.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
    await b.call('memory:create', { category: 'personal', key: 'mother', value: 'FATEMA-PRIVATE' });
    await b.call('tasks:create', { request: 'TASK-PRIVATE-REQUEST' });
    const text = JSON.stringify(await get(b));
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(API_KEY.slice(0, 12));
    expect(text).not.toMatch(/FATEMA|TASK-PRIVATE/);
  });
});

describe('exporting diagnostics', () => {
  const home = '/home/someone';
  const setup = (over: { pick?: (t: string, n: string) => Promise<string | undefined> } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-diag-'));
    scratch.push(dir);
    const target = join(dir, 'diagnostics.json');
    const asked: string[] = [];
    const b = boot({
      diagnostics: {
        home,
        logsFolder: `${home}/.config/Allaya/logs`,
        readLogTail: () =>
          Promise.resolve([
            `{"level":"ERROR","message":"failed to open ${home}/Documents/plan.txt with key sk-ant-api03-ABCDEFGHIJKLMNOP"}`,
            `{"level":"INFO","message":"Bearer abcdefghijklmnop12345 used"}`,
          ]),
        pickSaveFile:
          over.pick ??
          ((_title, name) => {
            asked.push(name);
            return Promise.resolve(target);
          }),
      },
    });
    return { b, target, asked };
  };

  it('saves the report and recent log lines to the file the person picks, with secrets and their home folder removed', async () => {
    const { b, target, asked } = setup();
    await b.call('memory:create', { category: 'personal', key: 'mother', value: 'FATEMA-PRIVATE' });
    expect(data(await b.call('diagnostics:export'))).toEqual({ saved: true });
    expect(asked).toEqual(['allaya-diagnostics.json']);
    const raw = readFileSync(target, 'utf8');
    const file = JSON.parse(raw) as { note: string; report: Diagnostics; logTail: string[] };
    expect(file.note).toMatch(/no chat, memories, tasks or file contents/);
    expect(file.report.app.name).toBeTruthy();
    expect(file.logTail).toHaveLength(2);
    expect(raw).not.toContain('sk-ant-api03');
    expect(raw).not.toContain('abcdefghijklmnop12345');
    expect(raw).not.toContain('/home/someone');
    expect(raw).toContain('~/Documents/plan.txt');
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('FATEMA');
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o077).toBe(0);
    // The person's folder name also goes from the report itself.
    expect(file.report.logs.folder).toBe('~/.config/Allaya/logs');
  });

  it('saves nothing when the dialog is cancelled, and nothing is offered where there is no dialog', async () => {
    const { b, target } = setup({ pick: () => Promise.resolve(undefined) });
    expect(data(await b.call('diagnostics:export'))).toEqual({ saved: false });
    expect(() => readFileSync(target)).toThrow();
    const bare = boot();
    expect(data(await bare.call('diagnostics:export'))).toEqual({ saved: false });
  });

  it('the renderer cannot name where it is saved', async () => {
    const { b } = setup();
    const result = (await b.call('diagnostics:export', { path: '/etc/passwd' })) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it('a missing or failing log does not stop the export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-diag-'));
    scratch.push(dir);
    const target = join(dir, 'd.json');
    const b = boot({
      diagnostics: {
        readLogTail: () => Promise.reject(new Error('disk gone')),
        pickSaveFile: () => Promise.resolve(target),
      },
    });
    expect(data(await b.call('diagnostics:export'))).toEqual({ saved: true });
    expect((JSON.parse(readFileSync(target, 'utf8')) as { logTail: string[] }).logTail).toEqual([]);
  });
});

describe('scrubbing text for sharing', () => {
  it('removes the home folder in every spelling, and credentials', () => {
    expect(scrub('C:\\Users\\Sam\\Docs and C:/Users/Sam/x', 'C:\\Users\\Sam')).toBe(
      '~\\Docs and ~/x',
    );
    expect(scrub('/home/sam/a', '/home/sam')).toBe('~/a');
    expect(scrub('key sk-ant-api03-ABCDEFGHIJKL here', undefined)).toBe('key [REDACTED] here');
  });
  it('ignores a home folder too short to be meaningful (it would mangle the text)', () => {
    expect(scrub('a/b/c', '/')).toBe('a/b/c');
    expect(scrub('a/b/c', '')).toBe('a/b/c');
  });
});
