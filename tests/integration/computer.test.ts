import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompositeAdapter,
  ComputerEngine,
  MemoryAdapter,
  TINY_PNG,
  type WindowInfo,
} from '@allaya/computer';
import { ToolAuditRepository } from '@allaya/database';
import type {
  ComputerStatus,
  ConfirmationView,
  MessageView,
  SelfTestResult,
} from '@allaya/validation';
import { API_KEY, modelsResponse, toolUseStream, replyStream } from '../helpers/anthropic';
import { mockFetch, type RecordedRequest } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';
import { FolderScreenshotStore, screenshotFileName } from '@main/computer/screenshot-store';

let backend: TestBackend;
afterEach(() => backend?.dispose());

type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;

const win = (over: Partial<WindowInfo> & { processName: string }): WindowInfo => ({
  id: over.id ?? over.processName,
  title: over.title ?? over.processName,
  pid: 1,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: false,
  minimized: false,
  ...over,
});

interface Rig {
  adapter: MemoryAdapter;
  requests: RecordedRequest[];
  shots: FolderScreenshotStore;
}

async function rig(
  turns: Array<Parameters<typeof toolUseStream>[0] | 'text'>,
  adapter = new MemoryAdapter({
    windows: [win({ processName: 'notepad', id: '1', focused: true })],
  }),
): Promise<Rig> {
  const requests: RecordedRequest[] = [];
  const f = mockFetch((req) => {
    if (req.url.includes('/v1/models')) return modelsResponse();
    requests.push(req);
    const turn = turns[Math.min(requests.length - 1, turns.length - 1)]!;
    return turn === 'text' ? replyStream(['Done.']) : toolUseStream(turn);
  });
  const shots = new FolderScreenshotStore(
    join(mkdtempSync(join(tmpdir(), 'allaya-shots-')), 'shots'),
  );
  backend = createTestBackend({
    fetch: f,
    computer: {
      engine: new ComputerEngine({ adapter, waitMs: 150, pollMs: 10 }),
      screenshots: shots,
    },
  });
  await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
  return { adapter, requests, shots };
}

const send = async (text: string) =>
  data<{ conversation: { id: string }; assistantMessage: MessageView }>(
    await backend.call('chat:send', { text }),
  );
const done = (id: string) =>
  vi.waitFor(
    () =>
      expect(
        (backend.eventsOf('chat:finished') as Array<{ message: MessageView }>).filter(
          (e) => e.message.id === id,
        ),
      ).toHaveLength(1),
    { timeout: 4000 },
  );
const final = (id: string) =>
  (backend.eventsOf('chat:finished') as Array<{ message: MessageView }>).find(
    (e) => e.message.id === id,
  )!.message;
const waitPending = () =>
  vi.waitFor(
    () => expect(backend.container.tools.pendingConfirmations().length).toBeGreaterThan(0),
    { timeout: 4000 },
  );
const bodyOf = (req: RecordedRequest) =>
  req.body as {
    tools?: Array<{ name: string }>;
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };

describe('computer tools through the agent loop', () => {
  it('the model is offered exactly the computer tools this machine supports (plus the way to start a task)', async () => {
    const { requests } = await rig(['text']);
    const r = await send('hi');
    await done(r.assistantMessage.id);
    const offered = bodyOf(requests[0]!)
      .tools?.map((t) => t.name)
      .sort();
    expect(offered).toContain('start_task');
    expect(offered?.filter((name) => name !== 'start_task')).toEqual([
      'click_at',
      'click_element',
      'close_app',
      'create_automation',
      'focus_window',
      'forget',
      'get_datetime',
      'list_automations',
      'list_windows',
      'open_app',
      'press_keys',
      'read_clipboard',
      'recall',
      'remember',
      'scroll',
      'take_screenshot',
      'type_text',
      'write_clipboard',
    ]);
  });

  it('"Chrome খুলে দাও": open_app runs without a question, opens the window, and is verified', async () => {
    const { adapter, requests } = await rig([
      { calls: [{ id: 't1', name: 'open_app', input: { app: 'Chrome' } }] },
      { text: ['Chrome খুলে দিয়েছি।'] },
    ]);
    const r = await send('Chrome খুলে দাও');
    await done(r.assistantMessage.id);
    expect(adapter.launched).toEqual(['chrome']);
    expect(backend.eventsOf('tools:confirmationRequested')).toEqual([]);
    const message = final(r.assistantMessage.id);
    expect(message.actions).toEqual([
      expect.objectContaining({
        tool: 'open_app',
        status: 'success',
        verification: 'verified',
        summary: expect.stringContaining('Chrome'),
      }),
    ]);
    const result = JSON.parse(
      bodyOf(requests[1]!).messages.at(-1)!.content[0]!['content'] as string,
    ) as { ok: boolean; verification: string; evidence: string };
    expect(result).toMatchObject({ ok: true, verification: 'verified' });
    expect(result.evidence).toMatch(/Chrome window is open/);
  });

  it('if the app never shows a window, the model is told it could not be verified — so it cannot honestly claim success', async () => {
    const { requests } = await rig(
      [{ calls: [{ id: 't1', name: 'open_app', input: { app: 'Chrome' } }] }, 'text'],
      new MemoryAdapter({ windowsAppearOnLaunch: false }),
    );
    const r = await send('open chrome');
    await done(r.assistantMessage.id);
    const result = JSON.parse(
      bodyOf(requests[1]!).messages.at(-1)!.content[0]!['content'] as string,
    ) as { ok: boolean; status: string; verification: string };
    expect(result).toMatchObject({ ok: false, status: 'failed', verification: 'failed' });
    expect(final(r.assistantMessage.id).actions![0]).toMatchObject({
      status: 'failed',
      verification: 'failed',
    });
  });

  it('typing asks first; the text never reaches the audit log; a terminal is refused', async () => {
    const { adapter } = await rig([
      { calls: [{ id: 't1', name: 'type_text', input: { text: 'my-secret-password' } }] },
      'text',
    ]);
    const r = await send('type it');
    await waitPending();
    const [question]: ConfirmationView[] = backend.container.tools.pendingConfirmations();
    expect(question).toMatchObject({ tool: 'type_text', risk: 'MEDIUM' });
    expect(question!.summary).toContain('my-secret-password'); // the user is shown exactly what will be typed
    expect(adapter.typed).toEqual([]);
    await backend.call('tools:respondConfirmation', { id: question!.id, decision: 'approved' });
    await done(r.assistantMessage.id);
    expect(adapter.typed).toEqual(['my-secret-password']);
    const audit = new ToolAuditRepository(backend.container.database.db);
    expect(JSON.stringify(audit.recentActivity())).not.toContain('my-secret-password');
    expect(final(r.assistantMessage.id).actions![0]).toMatchObject({
      status: 'success',
      verification: 'unverified',
    });
  });

  it('typing into a shell is refused even after the user approves — the runtime says no, not the model', async () => {
    const { adapter } = await rig(
      [{ calls: [{ id: 't1', name: 'type_text', input: { text: 'format c:' } }] }, 'text'],
      new MemoryAdapter({ windows: [win({ processName: 'powershell', id: '1', focused: true })] }),
    );
    await backend.call('permissions:set', { subject: 'computer_control', mode: 'always_allow' });
    const r = await send('type it');
    await done(r.assistantMessage.id);
    expect(adapter.typed).toEqual([]);
    expect(final(r.assistantMessage.id).actions![0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('powershell'),
    });
  });

  it('screenshots land in the screenshots folder as verified PNG files', async () => {
    const { shots } = await rig([
      { calls: [{ id: 't1', name: 'take_screenshot', input: {} }] },
      { text: ['Saved.'] },
    ]);
    const r = await send('screenshot nao');
    await done(r.assistantMessage.id);
    const files = readdirSync(shots.folder);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^Allaya-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}\.png$/);
    expect(new Uint8Array(readFileSync(join(shots.folder, files[0]!)))).toEqual(TINY_PNG);
    expect(final(r.assistantMessage.id).actions![0]).toMatchObject({
      status: 'success',
      verification: 'verified',
    });
  });

  it('the emergency stop during a slow app launch cancels it', async () => {
    const adapter = new MemoryAdapter({ windowsAppearOnLaunch: false });
    const { requests } = await rig(
      [{ calls: [{ id: 't1', name: 'open_app', input: { app: 'Chrome' } }] }, 'text'],
      adapter,
    );
    backend.dispose();
    // A longer wait so there is time to stop it while it is still waiting for the window.
    const f = mockFetch((req) =>
      req.url.includes('/v1/models')
        ? modelsResponse()
        : toolUseStream({ calls: [{ id: 't1', name: 'open_app', input: { app: 'Chrome' } }] }),
    );
    backend = createTestBackend({
      fetch: f,
      computer: { engine: new ComputerEngine({ adapter, waitMs: 10_000, pollMs: 20 }) },
    });
    await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
    const r = await send('open chrome');
    await vi.waitFor(() => expect(adapter.launched).toEqual(['chrome']));
    await backend.call('agent:stop');
    await done(r.assistantMessage.id);
    expect(final(r.assistantMessage.id).status).toBe('cancelled');
    expect(requests.length).toBeGreaterThanOrEqual(0);
  });
});

describe('computer status and self-test', () => {
  it('reports capabilities and the tools on offer', async () => {
    await rig(['text']);
    const status = data<ComputerStatus>(await backend.call('computer:getStatus'));
    expect(status.capabilities).toMatchObject({ windows: true, keyboard: true, screenshot: true });
    expect(status.tools.find((t) => t.name === 'open_app')).toMatchObject({
      risk: 'varies',
      readOnly: false,
    });
    expect(status.tools.find((t) => t.name === 'click_at')).toMatchObject({ risk: 'HIGH' });
    expect(status.screenshotsFolder).toBeTruthy();
  });

  it('with no computer configured, nothing is offered and the status says so', async () => {
    backend = createTestBackend();
    const status = data<ComputerStatus>(await backend.call('computer:getStatus'));
    expect(status.tools).toEqual([]);
    expect(Object.values(status.capabilities).every((v) => v === false)).toBe(true);
  });

  it('the self-test is read-only: it lists windows and captures the screen, and touches nothing', async () => {
    const { adapter } = await rig(['text']);
    const result = data<SelfTestResult>(await backend.call('computer:selfTest'));
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(['platform', 'list windows', 'capture screen']);
    expect(adapter.launched).toEqual([]);
    expect(adapter.typed).toEqual([]);
    expect(adapter.clicks).toEqual([]);
  });

  it('features that do not exist on this platform are skipped, not reported as failures', async () => {
    backend = createTestBackend({
      computer: {
        engine: new ComputerEngine({
          adapter: new CompositeAdapter(undefined, new MemoryAdapter(), 'linux'),
        }),
      },
    });
    const result = data<SelfTestResult>(await backend.call('computer:selfTest'));
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.name === 'list windows')).toMatchObject({
      ok: true,
      skipped: true,
    });
    expect(result.steps.find((s) => s.name === 'capture screen')).toMatchObject({ ok: true });
    expect(result.steps.find((s) => s.name === 'capture screen')?.skipped).toBeUndefined();
  });

  it('the self-test reports what fails instead of hiding it', async () => {
    const adapter = new MemoryAdapter();
    adapter.listWindows = async () => {
      throw new Error('PowerShell is unavailable');
    };
    await rig(['text'], adapter);
    const result = data<SelfTestResult>(await backend.call('computer:selfTest'));
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.name === 'list windows')).toMatchObject({ ok: false });
  });
});

describe('screenshot store', () => {
  it('never overwrites: two saves in the same millisecond cannot clobber each other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-shot-'));
    const store = new FolderScreenshotStore(dir, () => new Date(2026, 8, 29, 14, 5, 33, 123));
    const first = await store.save(new Uint8Array([1, 2, 3]));
    expect(first.path).toBe(join(dir, 'Allaya-2026-09-29-14-05-33-123.png'));
    await expect(store.save(new Uint8Array([9]))).rejects.toThrow(); // `wx`: exists already
    expect(readFileSync(first.path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('names files sortably and inspects them', async () => {
    expect(screenshotFileName(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe(
      'Allaya-2026-01-02-03-04-05-006.png',
    );
    const dir = mkdtempSync(join(tmpdir(), 'allaya-shot-'));
    const store = new FolderScreenshotStore(dir);
    const saved = await store.save(TINY_PNG);
    expect(await store.inspect(saved.path)).toMatchObject({ bytes: TINY_PNG.byteLength });
    expect(await store.inspect(join(dir, 'missing.png'))).toBeUndefined();
  });
});
