import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@allaya/database';
import type {
  ConfirmationView,
  FileListing,
  FileOutcome,
  FilesOverview,
  MessageView,
} from '@allaya/validation';
import { API_KEY, modelsResponse, replyStream, toolUseStream } from '../helpers/anthropic';
import { mockFetch, type RecordedRequest } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';
import { fsFixture, type FsFixture } from '../helpers/fs-fixture';

let backend: TestBackend | undefined;
let fx: FsFixture;
let fxReady = false;
/** A fresh sandbox for this test (every test that touches the disk starts from an empty one). */
const newFx = (options?: Parameters<typeof fsFixture>[0]) => {
  fx = fsFixture(options);
  fxReady = true;
  return fx;
};
afterEach(() => {
  backend?.dispose();
  backend = undefined;
  if (fxReady) fx.cleanup();
  fxReady = false;
});

type Ok<T> = { ok: true; data: T };
type Failed = {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
};
const data = <T>(r: unknown) => (r as Ok<T>).data;
const failure = (r: unknown) => (r as Failed).error;

const filesOption = (over: Record<string, unknown> = {}) => ({
  knownFolders: { documents: fx.documents, desktop: fx.desktop },
  protectedPaths: [fx.appData],
  home: fx.base,
  backupsFolder: join(fx.appData, 'file-backups'),
  trash: fx.trash,
  opener: (path: string) => {
    fx.opened.push(path);
    return Promise.resolve();
  },
  ...over,
});

interface Rig {
  requests: RecordedRequest[];
}

async function rig(
  turns: Array<Parameters<typeof toolUseStream>[0] | 'text'> = ['text'],
  over: Record<string, unknown> = {},
  databasePath?: string,
): Promise<Rig> {
  if (!fxReady) newFx();
  const requests: RecordedRequest[] = [];
  const f = mockFetch((req) => {
    if (req.url.includes('/v1/models')) return modelsResponse();
    requests.push(req);
    const turn = turns[Math.min(requests.length - 1, turns.length - 1)]!;
    return turn === 'text' ? replyStream(['Done.']) : toolUseStream(turn);
  });
  backend = createTestBackend({
    fetch: f,
    files: filesOption(over),
    ...(databasePath ? { databasePath } : {}),
  });
  await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
  return { requests };
}

const send = async (text: string) =>
  data<{ conversation: { id: string }; assistantMessage: MessageView }>(
    await backend!.call('chat:send', { text }),
  );
const done = (id: string) =>
  vi.waitFor(
    () =>
      expect(
        (backend!.eventsOf('chat:finished') as Array<{ message: MessageView }>).filter(
          (e) => e.message.id === id,
        ),
      ).toHaveLength(1),
    { timeout: 4000 },
  );
const final = (id: string) =>
  (backend!.eventsOf('chat:finished') as Array<{ message: MessageView }>).find(
    (e) => e.message.id === id,
  )!.message;
const waitPending = () =>
  vi.waitFor(
    () => expect(backend!.container.tools.pendingConfirmations().length).toBeGreaterThan(0),
    { timeout: 4000 },
  );
const pending = (): ConfirmationView => backend!.container.tools.pendingConfirmations()[0]!;
const answer = (decision: 'approved' | 'rejected') =>
  backend!.call('tools:respondConfirmation', { id: pending().id, decision });
const resultSeenByModel = (req: RecordedRequest) => {
  const body = req.body as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  return JSON.parse(body.messages.at(-1)!.content[0]!['content'] as string) as Record<
    string,
    unknown
  >;
};
const auditDump = () => {
  const { db } = backend!.container.database;
  return JSON.stringify([
    db.select().from(schema.toolCalls).all(),
    db.select().from(schema.toolResults).all(),
    db.select().from(schema.activityLogs).all(),
  ]);
};

describe('file tools through the agent loop', () => {
  it('offers the file tools only when file access is configured', async () => {
    await rig();
    expect(backend!.container.tools.modelTools().map((t) => t.name)).toEqual(
      expect.arrayContaining(['list_folder', 'write_file', 'delete_folder', 'read_file']),
    );
    backend!.dispose();
    backend = createTestBackend({ fetch: mockFetch(() => modelsResponse()) });
    expect(
      backend.container.tools
        .modelTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['create_automation', 'get_datetime', 'list_automations']);
  });

  it('"Documents e todo.txt banao": write_file asks, creates the file, reads it back and is verified', async () => {
    const { requests } = await rig([
      {
        calls: [
          {
            id: 't1',
            name: 'write_file',
            input: { path: 'Documents/todo.txt', content: 'আজকের কাজ: বাজার — private-note-777' },
          },
        ],
      },
      { text: ['todo.txt তৈরি করেছি।'] },
    ]);
    const r = await send('Documents e todo.txt banao');
    await waitPending();
    expect(pending()).toMatchObject({ tool: 'write_file', risk: 'MEDIUM' });
    expect(pending().summary).toContain('Documents/todo.txt');
    expect(existsSync(join(fx.documents, 'todo.txt'))).toBe(false); // nothing happened before the answer
    await answer('approved');
    await done(r.assistantMessage.id);
    expect(readFileSync(join(fx.documents, 'todo.txt'), 'utf8')).toContain('বাজার');
    expect(final(r.assistantMessage.id).actions![0]).toMatchObject({
      tool: 'write_file',
      status: 'success',
      verification: 'verified',
    });
    expect(resultSeenByModel(requests[1]!)).toMatchObject({ ok: true, verification: 'verified' });
    // the audit trail says a file was written, not what was in it
    expect(auditDump()).not.toContain('private-note-777');
    expect(auditDump()).toContain('Documents/todo.txt');
  });

  it('declining leaves the disk untouched, and the model is told not to try again', async () => {
    const { requests } = await rig([
      {
        calls: [{ id: 't1', name: 'write_file', input: { path: 'Documents/x.txt', content: 'x' } }],
      },
      'text',
    ]);
    const r = await send('make x');
    await waitPending();
    await answer('rejected');
    await done(r.assistantMessage.id);
    expect(existsSync(join(fx.documents, 'x.txt'))).toBe(false);
    expect(resultSeenByModel(requests[1]!)).toMatchObject({ ok: false, status: 'rejected' });
  });

  it('reading a file asks first, sends the text to the model, and keeps it out of the audit log', async () => {
    newFx();
    fx.write('Documents/diary.txt', 'my bank PIN is 4711');
    const { requests } = await rig([
      { calls: [{ id: 't1', name: 'read_file', input: { path: 'Documents/diary.txt' } }] },
      'text',
    ]);
    const r = await send('read my diary');
    await waitPending();
    expect(pending().summary).toContain('sent to your AI provider');
    await answer('approved');
    await done(r.assistantMessage.id);
    expect(JSON.stringify(resultSeenByModel(requests[1]!))).toContain('4711');
    expect(auditDump()).not.toContain('4711');
  });

  it('a model that asks for a secret file or a path outside the folders is refused by the runtime', async () => {
    newFx();
    fx.write('Documents/.env', 'TOKEN=abc123');
    fx.write('Outside/passwords.txt', 'hunter2');
    await backend?.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
    const { requests } = await rig([
      {
        calls: [
          { id: 't1', name: 'read_file', input: { path: 'Documents/.env' } },
          { id: 't2', name: 'read_file', input: { path: join(fx.outside, 'passwords.txt') } },
          { id: 't3', name: 'list_folder', input: { path: 'Documents/../Outside' } },
          { id: 't4', name: 'list_folder', input: { path: '/etc' } },
        ],
      },
      'text',
    ]);
    await backend!.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
    const r = await send('show me secrets');
    await done(r.assistantMessage.id);
    const results = (
      requests[1]!.body as { messages: Array<{ content: Array<{ content: string }> }> }
    ).messages
      .at(-1)!
      .content.map((c) => JSON.parse(c.content) as { ok: boolean; error?: string });
    expect(results.every((x) => !x.ok)).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/abc123|hunter2/);
  });

  it('deleting a folder needs an on-screen click — typing or saying "yes" cannot approve it', async () => {
    newFx();
    fx.write('Documents/old/a.txt');
    await rig([
      { calls: [{ id: 't1', name: 'delete_folder', input: { path: 'Documents/old' } }] },
      'text',
    ]);
    const r = await send('delete the old folder');
    await waitPending();
    expect(pending()).toMatchObject({ tool: 'delete_folder', risk: 'CRITICAL', channels: ['ui'] });
    const said = await send('yes');
    expect(said.assistantMessage).toBeDefined();
    expect(existsSync(join(fx.documents, 'old', 'a.txt'))).toBe(true); // still there
    await answer('approved');
    await done(r.assistantMessage.id);
    expect(existsSync(join(fx.documents, 'old'))).toBe(false);
    expect(readdirSync(join(fx.appData, 'trash'))).toHaveLength(1); // in the trash, not gone
  });

  it('a deleted file can be brought back with undo, which asks first', async () => {
    newFx();
    fx.write('Documents/precious.txt', 'keep me');
    await rig([
      { calls: [{ id: 't1', name: 'delete_file', input: { path: 'Documents/precious.txt' } }] },
      { calls: [{ id: 't2', name: 'undo_file_action', input: {} }] },
      'text',
    ]);
    const r = await send('delete precious then undo');
    await waitPending();
    await answer('approved'); // the delete
    await vi.waitFor(() => expect(existsSync(join(fx.documents, 'precious.txt'))).toBe(false));
    await vi.waitFor(() => expect(backend!.container.tools.pendingConfirmations()).toHaveLength(1));
    expect(pending()).toMatchObject({ tool: 'undo_file_action' });
    expect(pending().summary).toContain('precious.txt');
    await answer('approved'); // the undo
    await done(r.assistantMessage.id);
    expect(readFileSync(join(fx.documents, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('when file access is switched off, every file tool is denied and nothing is asked', async () => {
    newFx();
    fx.write('Documents/a.txt');
    await rig([
      { calls: [{ id: 't1', name: 'list_folder', input: { path: 'Documents' } }] },
      'text',
    ]);
    await backend!.call('permissions:set', { subject: 'file_access', mode: 'never' });
    const r = await send('list documents');
    await done(r.assistantMessage.id);
    expect(backend!.eventsOf('tools:confirmationRequested')).toEqual([]);
    expect(final(r.assistantMessage.id).actions![0]).toMatchObject({ status: 'denied' });
  });
});

describe('the Files screen backend', () => {
  it('lists the known folders and what is in them', async () => {
    newFx();
    fx.write('Documents/Reports/q1.txt');
    fx.write('Documents/notes.txt');
    fx.write('Documents/.env');
    await rig();
    const overview = data<FilesOverview>(await backend!.call('files:overview'));
    expect(overview.roots.map((r) => r.label)).toEqual(['Desktop', 'Documents']);
    expect(overview.roots.every((r) => r.exists)).toBe(true);
    expect(overview.accessOff).toBe(false);
    const listing = data<FileListing>(await backend!.call('files:list', { path: 'Documents' }));
    expect(listing.entries.map((e) => e.name)).toEqual(['Reports', 'notes.txt']);
    expect(listing.omitted).toBe(1);
    const found = data<{ hits: Array<{ path: string }> }>(
      await backend!.call('files:search', { query: 'q1' }),
    );
    expect(found.hits.map((h) => h.path)).toEqual(['Documents/Reports/q1.txt']);
  });

  it('refuses paths outside the folders with a stable reason the screen can translate', async () => {
    newFx();
    await rig();
    for (const [path, reason] of [
      ['/etc', 'outside_roots'],
      ['Documents/../Outside', 'traversal'],
      ['Documents/.ssh', 'secret'],
    ] as const) {
      const error = failure(await backend!.call('files:list', { path }));
      expect(error.details).toMatchObject({ reason });
      expect(error.message).not.toContain(fx.base);
    }
  });

  it('a folder the user adds is usable straight away; unsafe ones are refused', async () => {
    newFx();
    const projects = fx.dir('Projects');
    fx.write('Projects/app/main.ts');
    let picked = projects;
    await rig(['text'], { pickFolder: () => Promise.resolve(picked) });
    const added = data<{ added?: { id: string; label: string; origin: string } }>(
      await backend!.call('files:addFolder'),
    );
    expect(added.added).toMatchObject({ label: 'Projects', origin: 'user' });
    const listing = data<FileListing>(await backend!.call('files:list', { path: 'Projects/app' }));
    expect(listing.entries.map((e) => e.name)).toEqual(['main.ts']);
    // the model's tools see it too
    const overview = data<FilesOverview>(await backend!.call('files:overview'));
    expect(overview.roots.map((r) => r.label)).toContain('Projects');

    for (const bad of [fx.base, fx.appData, '/', join(fx.appData, 'trash')]) {
      picked = bad;
      const result = await backend!.call('files:addFolder');
      expect(result, bad).toMatchObject({ ok: false });
    }
    // a folder already inside an allowed folder adds nothing new
    picked = join(fx.documents);
    const again = data<{ added?: { label: string } }>(await backend!.call('files:addFolder'));
    expect(again.added?.label).toBe('Documents');
    expect(data<FilesOverview>(await backend!.call('files:overview')).roots).toHaveLength(3);

    expect(failure(await backend!.call('files:removeFolder', { id: 'documents' })).code).toBe(
      'NOT_FOUND',
    );
    expect(await backend!.call('files:removeFolder', { id: added.added!.id })).toMatchObject({
      ok: true,
    });
    expect(failure(await backend!.call('files:list', { path: 'Projects' })).details).toMatchObject({
      reason: 'outside_roots',
    });
  });

  it('cancelling the folder picker adds nothing; a missing picker is reported', async () => {
    newFx();
    await rig(['text'], { pickFolder: () => Promise.resolve(undefined) });
    expect(data(await backend!.call('files:addFolder'))).toEqual({});
    backend!.dispose();
    await rig(['text'], { pickFolder: undefined });
    expect(failure(await backend!.call('files:addFolder')).code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('creating a folder runs through the tool pipeline: audited, verified, undoable, announced', async () => {
    newFx();
    await rig();
    const outcome = data<FileOutcome>(
      await backend!.call('files:createFolder', { path: 'Documents/New' }),
    );
    expect(outcome).toMatchObject({ ok: true, status: 'success' });
    expect(outcome.evidence).toContain('exists');
    expect(existsSync(join(fx.documents, 'New'))).toBe(true);
    expect(backend!.eventsOf('files:changed').length).toBeGreaterThan(0);
    expect(auditDump()).toContain('create_folder');
    const overview = data<FilesOverview>(await backend!.call('files:overview'));
    expect(overview.actions[0]).toMatchObject({
      kind: 'create_folder',
      label: 'Documents/New',
      undoable: true,
    });
  });

  it('renaming asks first; declining changes nothing', async () => {
    newFx();
    fx.write('Documents/a.txt', 'A');
    await rig();
    const pendingOutcome = backend!.call('files:rename', {
      path: 'Documents/a.txt',
      newName: 'b.txt',
    });
    await waitPending();
    expect(pending()).toMatchObject({ tool: 'rename_file', risk: 'MEDIUM' });
    await answer('rejected');
    expect(data<FileOutcome>(await pendingOutcome)).toMatchObject({
      ok: false,
      status: 'rejected',
    });
    expect(existsSync(join(fx.documents, 'a.txt'))).toBe(true);

    const second = backend!.call('files:rename', { path: 'Documents/a.txt', newName: 'b.txt' });
    await waitPending();
    await answer('approved');
    expect(data<FileOutcome>(await second)).toMatchObject({ ok: true, status: 'success' });
    expect(existsSync(join(fx.documents, 'b.txt'))).toBe(true);
  });

  it('deleting a folder from the screen needs the on-screen confirmation, then undo restores it', async () => {
    newFx();
    fx.write('Documents/dir/a.txt', 'A');
    await rig();
    const deleting = backend!.call('files:delete', { path: 'Documents/dir', folder: true });
    await waitPending();
    expect(pending()).toMatchObject({ tool: 'delete_folder', risk: 'CRITICAL' });
    await answer('approved');
    expect(data<FileOutcome>(await deleting)).toMatchObject({ ok: true });
    expect(existsSync(join(fx.documents, 'dir'))).toBe(false);

    const undoing = backend!.call('files:undo', {});
    await waitPending();
    await answer('approved');
    expect(data<FileOutcome>(await undoing)).toMatchObject({ ok: true });
    expect(readFileSync(join(fx.documents, 'dir', 'a.txt'), 'utf8')).toBe('A');
  });

  it('the emergency stop cancels a delete that is waiting for an answer, leaving the folder alone', async () => {
    newFx();
    fx.write('Documents/dir/a.txt');
    await rig();
    const deleting = backend!.call('files:delete', { path: 'Documents/dir', folder: true });
    await waitPending();
    await backend!.call('agent:stop');
    const outcome = data<FileOutcome>(await deleting);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toMatch(/cancelled|rejected/);
    expect(existsSync(join(fx.documents, 'dir', 'a.txt'))).toBe(true);
  });

  it('opening a file goes through the host; programs and secrets are refused', async () => {
    newFx();
    fx.write('Documents/report.docx');
    fx.write('Documents/setup.exe');
    await rig();
    expect(await backend!.call('files:open', { path: 'Documents/report.docx' })).toMatchObject({
      ok: true,
    });
    expect(fx.opened).toEqual([join(fx.documents, 'report.docx')]);
    expect(
      failure(await backend!.call('files:open', { path: 'Documents/setup.exe' })).details,
    ).toMatchObject({
      reason: 'program_file',
    });
    expect(fx.opened).toHaveLength(1);
    const overview = data<FilesOverview>(await backend!.call('files:overview'));
    expect(overview.recent[0]).toMatchObject({
      label: 'report.docx',
      path: 'Documents/report.docx',
    });
  });

  it('shows a file in the file manager only when it is inside the allowed folders', async () => {
    newFx();
    fx.write('Documents/report.docx');
    fx.write('Documents/.env');
    fx.write('Outside/x.txt');
    const shown: string[] = [];
    await rig(['text'], { reveal: (path: string) => shown.push(path) });
    expect(await backend!.call('files:reveal', { path: 'Documents/report.docx' })).toMatchObject({
      ok: true,
    });
    expect(shown).toEqual([join(fx.documents, 'report.docx')]);
    for (const path of ['Documents/.env', join(fx.outside, 'x.txt'), 'Documents/../Outside']) {
      expect(await backend!.call('files:reveal', { path }), path).toMatchObject({ ok: false });
    }
    expect(shown).toHaveLength(1);
  });

  it('with file access switched off the screen reports it and every operation refuses', async () => {
    newFx();
    await rig();
    await backend!.call('permissions:set', { subject: 'file_access', mode: 'never' });
    expect(data<FilesOverview>(await backend!.call('files:overview')).accessOff).toBe(true);
    for (const [channel, payload] of [
      ['files:list', { path: 'Documents' }],
      ['files:search', { query: 'x' }],
      ['files:open', { path: 'Documents/a.txt' }],
      ['files:reveal', { path: 'Documents/a.txt' }],
      ['files:addFolder', undefined],
    ] as const) {
      expect(failure(await backend!.call(channel, payload)).code, channel).toBe(
        'PERMISSION_DENIED',
      );
    }
    const outcome = data<FileOutcome>(
      await backend!.call('files:createFolder', { path: 'Documents/x' }),
    );
    expect(outcome).toMatchObject({ ok: false, status: 'denied' });
    expect(existsSync(join(fx.documents, 'x'))).toBe(false);
  });

  it('without file access configured the channels exist but say it is unavailable', async () => {
    backend = createTestBackend({ fetch: mockFetch(() => modelsResponse()) });
    expect(data<FilesOverview>(await backend.call('files:overview'))).toMatchObject({
      roots: [],
      accessOff: true,
    });
    expect(failure(await backend.call('files:list', { path: 'Documents' })).code).toBe(
      'UNSUPPORTED_PLATFORM',
    );
  });

  it('rejects malformed requests before they reach the file code', async () => {
    newFx();
    await rig();
    for (const [channel, payload] of [
      ['files:list', {}],
      ['files:list', { path: '' }],
      ['files:list', { path: 'x'.repeat(2000) }],
      ['files:rename', { path: 'Documents/a', newName: '' }],
      ['files:delete', { path: 'Documents/a' }],
      ['files:search', { query: '' }],
    ] as const) {
      expect(failure(await backend!.call(channel, payload)).code, channel).toBe(
        'INVALID_IPC_PAYLOAD',
      );
    }
  });

  it('files:* is refused from an untrusted window', async () => {
    newFx();
    await rig();
    const result = await backend!.call(
      'files:list',
      { path: 'Documents' },
      { id: 9, frameUrl: 'https://evil.example/', isMainFrame: true },
    );
    expect(failure(result).code).toBe('UNAUTHORIZED_SENDER');
  });
});

describe('the undo journal survives a restart', () => {
  it('lets an undo work in a new session, and refuses it once the file was edited', async () => {
    newFx();
    const dbPath = join(mkdtempSync(join(tmpdir(), 'allaya-db-')), 'allaya.sqlite');
    await rig(['text'], {}, dbPath);
    await backend!.call('files:createFolder', { path: 'Documents/Made' });
    const before = data<FilesOverview>(await backend!.call('files:overview'));
    expect(before.actions[0]).toMatchObject({ kind: 'create_folder', undoable: true });

    backend!.dispose();
    await rig(['text'], {}, dbPath);
    const after = data<FilesOverview>(await backend!.call('files:overview'));
    expect(after.actions[0]).toMatchObject({
      kind: 'create_folder',
      label: 'Documents/Made',
      undoable: true,
    });
    writeFileSync(join(fx.documents, 'Made', 'user-file.txt'), 'the user added this');
    const undoing = backend!.call('files:undo', {});
    await waitPending();
    await answer('approved');
    const outcome = data<FileOutcome>(await undoing);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('could lose your work');
    expect(existsSync(join(fx.documents, 'Made', 'user-file.txt'))).toBe(true);
  });
});
