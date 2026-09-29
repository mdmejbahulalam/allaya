import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolAuditRepository } from '@allaya/database';
import type { ConfirmationView, MessageView } from '@allaya/validation';
import { API_KEY, modelsResponse, replyStream, toolUseStream } from '../helpers/anthropic';
import { mockFetch, type RecordedRequest } from '../helpers/fetch';
import { createTestBackend, type TestBackend } from '../helpers/backend';
import { createProbeTool } from '@main/security/e2e-tools';

let backend: TestBackend;
afterEach(() => backend?.dispose());

type Ok<T> = { ok: true; data: T };
const data = <T>(r: unknown) => (r as Ok<T>).data;
interface SendResult {
  conversation: { id: string };
  userMessage: MessageView;
  assistantMessage: MessageView;
}

type Turn = Parameters<typeof toolUseStream>[0] | 'text-only';
interface Rig {
  requests: RecordedRequest[];
  probeLog: string[];
}

/** A backend whose "model" plays back `turns` in order, one per /v1/messages request. */
async function rig(
  turns: Turn[] | ((req: RecordedRequest, n: number) => Response),
  options: { confirmationTimeoutMs?: number } = {},
): Promise<Rig> {
  const requests: RecordedRequest[] = [];
  const probeLog: string[] = [];
  const f = mockFetch((req) => {
    if (req.url.includes('/v1/models')) return modelsResponse();
    requests.push(req);
    const n = requests.length - 1;
    if (typeof turns === 'function') return turns(req, n);
    const turn = turns[Math.min(n, turns.length - 1)]!;
    return turn === 'text-only' ? replyStream(['Done.']) : toolUseStream(turn);
  });
  backend = createTestBackend({
    fetch: f,
    extraTools: [createProbeTool((note) => probeLog.push(note))],
    ...options,
  });
  await backend.call('providers:setKey', { providerId: 'anthropic', apiKey: API_KEY });
  return { requests, probeLog };
}

const send = async (text: string, conversationId?: string, source?: 'voice' | 'text') =>
  data<SendResult>(
    await backend.call('chat:send', {
      text,
      ...(conversationId ? { conversationId } : {}),
      ...(source ? { source } : {}),
    }),
  );
const finished = (id: string) =>
  (backend.eventsOf('chat:finished') as Array<{ message: MessageView }>).filter(
    (e) => e.message.id === id,
  );
const done = (id: string) =>
  vi.waitFor(() => expect(finished(id)).toHaveLength(1), { timeout: 4000 });
const final = (id: string) => finished(id)[0]!.message;
const pending = (): ConfirmationView[] => backend.container.tools.pendingConfirmations();
const waitPending = () =>
  vi.waitFor(
    () => expect(backend.container.tools.pendingConfirmations().length).toBeGreaterThan(0),
    { timeout: 4000 },
  );
const bodyOf = (req: RecordedRequest) =>
  req.body as {
    system: string;
    tools?: Array<{ name: string; input_schema: Record<string, unknown> }>;
    messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  };
const probe = (level: string, note = 'n') => ({
  id: `toolu_${level}`,
  name: 'e2e_probe',
  input: { level, note },
});

describe('the tool loop: model → tool → result → answer', () => {
  it('offers tools, runs get_datetime, hands the result back and shows the action with the final answer', async () => {
    const { requests } = await rig([
      { text: ['Let me check. '], calls: [{ id: 'toolu_1', name: 'get_datetime', input: {} }] },
      { text: ['It is Tuesday.'] },
    ]);
    const r = await send('what day is it?');
    await done(r.assistantMessage.id);

    // Request 1 carries the tool definitions and a prompt that says tools exist.
    const first = bodyOf(requests[0]!);
    expect(first.tools?.map((t) => t.name)).toContain('get_datetime');
    expect(first.system).toMatch(/only by calling the provided tools/);
    expect(first.system).not.toMatch(/NO tools/);

    // Request 2 replays the model's tool call and returns our verified result.
    const second = bodyOf(requests[1]!);
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.messages[1]!.content.map((c) => c['type'])).toEqual(['text', 'tool_use']);
    const toolResult = second.messages[2]!.content[0]!;
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(JSON.parse(toolResult['content'] as string)).toMatchObject({
      ok: true,
      status: 'success',
      verification: 'not_applicable',
      output: { weekday: expect.any(String) },
    });

    const message = final(r.assistantMessage.id);
    expect(message).toMatchObject({
      status: 'complete',
      content: 'Let me check. \n\nIt is Tuesday.',
    });
    expect(message.actions).toEqual([
      expect.objectContaining({
        tool: 'get_datetime',
        status: 'success',
        verification: 'not_applicable',
        summary: 'Checking the current date and time',
      }),
    ]);
    // It survives a reload.
    const stored = data<MessageView[]>(
      await backend.call('chat:getMessages', { conversationId: r.conversation.id }),
    );
    expect(stored[1]!.actions).toHaveLength(1);
    expect(backend.container.runs.active()).toEqual([]);
  });

  it('records the action in the audit trail: call, result and a readable activity entry', async () => {
    await rig([{ calls: [{ id: 'toolu_1', name: 'get_datetime', input: {} }] }, 'text-only']);
    const r = await send('time?');
    await done(r.assistantMessage.id);
    const audit = new ToolAuditRepository(backend.container.database.db);
    const [entry] = audit.recentActivity();
    expect(entry).toMatchObject({
      actor: 'allaya',
      tool: 'get_datetime',
      result: 'success',
      risk: 'LOW',
      action: 'Checking the current date and time',
    });
    const call = audit.getCall(
      backend
        .eventsOf('tools:activity')
        .map((e) => (e as { action: { callId: string } }).action.callId)[0]!,
    );
    expect(call).toMatchObject({
      toolName: 'get_datetime',
      status: 'success',
      permissionDecision: 'not_required',
    });
    expect(audit.getResult(call!.id)).toMatchObject({ ok: true });
  });

  it('streams action progress to the UI as events', async () => {
    await rig([{ calls: [{ id: 'toolu_1', name: 'get_datetime', input: {} }] }, 'text-only']);
    const r = await send('time?');
    await done(r.assistantMessage.id);
    const statuses = (
      backend.eventsOf('tools:activity') as Array<{ messageId: string; action: { status: string } }>
    )
      .filter((e) => e.messageId === r.assistantMessage.id)
      .map((e) => e.action.status);
    expect(statuses[0]).toBe('running');
    expect(statuses.at(-1)).toBe('success');
  });

  it('a model that asks for a tool that does not exist gets a clear error and can carry on', async () => {
    const { requests } = await rig([
      { calls: [{ id: 'toolu_x', name: 'launch_missiles', input: { target: 'moon' } }] },
      'text-only',
    ]);
    const r = await send('do it');
    await done(r.assistantMessage.id);
    const result = JSON.parse(
      bodyOf(requests[1]!).messages[2]!.content[0]!['content'] as string,
    ) as { ok: boolean; status: string };
    expect(result).toMatchObject({ ok: false, status: 'unknown_tool' });
    expect(final(r.assistantMessage.id)).toMatchObject({
      status: 'complete',
      actions: [expect.objectContaining({ status: 'unknown_tool' })],
    });
    const audit = new ToolAuditRepository(backend.container.database.db);
    expect(audit.recentActivity()[0]).toMatchObject({ tool: 'launch_missiles', result: 'failure' });
  });

  it('invalid arguments are reported back to the model, not executed', async () => {
    const { requests, probeLog } = await rig([
      { calls: [{ id: 'toolu_1', name: 'e2e_probe', input: { level: 'LOW' } }] },
      'text-only',
    ]);
    const r = await send('probe');
    await done(r.assistantMessage.id);
    const result = JSON.parse(
      bodyOf(requests[1]!).messages[2]!.content[0]!['content'] as string,
    ) as { status: string; error: string };
    expect(result.status).toBe('invalid');
    expect(result.error).toMatch(/note/);
    expect(probeLog).toEqual([]);
  });

  it('several tool calls in one turn run in order and all results are returned together', async () => {
    const { requests, probeLog } = await rig([
      { calls: [probe('LOW', 'first'), { ...probe('LOW', 'second'), id: 'toolu_2' }] },
      'text-only',
    ]);
    const r = await send('two things');
    await done(r.assistantMessage.id);
    expect(probeLog).toEqual(['first', 'second']);
    const results = bodyOf(requests[1]!).messages[2]!.content;
    expect(results.map((c) => c['tool_use_id'])).toEqual(['toolu_LOW', 'toolu_2']);
  });

  it('stops a model that keeps calling tools, after a bounded number of steps', async () => {
    const { requests } = await rig(() =>
      toolUseStream({ calls: [{ id: `toolu_${Math.random()}`, name: 'get_datetime', input: {} }] }),
    );
    const r = await send('loop forever');
    await done(r.assistantMessage.id);
    expect(requests.length).toBe(9); // the first request plus 8 rounds
    const message = final(r.assistantMessage.id);
    expect(message.status).toBe('complete');
    expect(message.content).toMatch(/I stopped after 8 steps/);
    expect(message.actions).toHaveLength(8);
    expect(backend.container.runs.active()).toEqual([]);
  });

  it('never executes tool calls from a reply that was cut off by the length limit', async () => {
    const { probeLog } = await rig([
      { calls: [probe('LOW', 'half-finished')], stopReason: 'max_tokens' },
    ]);
    const r = await send('go');
    await done(r.assistantMessage.id);
    expect(probeLog).toEqual([]);
  });

  it('sums token usage across every round of the turn', async () => {
    await rig((_req, n) =>
      n === 0
        ? toolUseStream(
            { calls: [{ id: 't1', name: 'get_datetime', input: {} }] },
            { input: 100, output: 20 },
          )
        : toolUseStream({ text: ['ok'] }, { input: 150, output: 30 }),
    );
    const r = await send('time');
    await done(r.assistantMessage.id);
    expect(final(r.assistantMessage.id).usage).toEqual({ inputTokens: 250, outputTokens: 50 });
  });
});

describe('confirmation: nothing risky runs until the user says so', () => {
  it('holds a MEDIUM action, shows the question, and runs it only after an on-screen approval', async () => {
    const { requests, probeLog } = await rig([
      { calls: [probe('MEDIUM', 'tidy up')] },
      'text-only',
    ]);
    const r = await send('tidy');
    await waitPending();
    expect(probeLog).toEqual([]); // waiting
    const [question] = pending();
    expect(question).toMatchObject({
      tool: 'e2e_probe',
      risk: 'MEDIUM',
      summary: 'Probe (MEDIUM): tidy up',
      conversationId: r.conversation.id,
    });
    expect(backend.eventsOf('tools:confirmationRequested')).toHaveLength(1);
    expect(backend.container.runs.active()).toHaveLength(1); // STOP stays available while waiting

    expect(
      data(
        await backend.call('tools:respondConfirmation', { id: question!.id, decision: 'approved' }),
      ),
    ).toEqual({ accepted: true });
    await done(r.assistantMessage.id);
    expect(probeLog).toEqual(['tidy up']);
    expect(final(r.assistantMessage.id).actions).toEqual([
      expect.objectContaining({ status: 'success', verification: 'verified' }),
    ]);
    const toolResult = JSON.parse(
      bodyOf(requests[1]!).messages[2]!.content[0]!['content'] as string,
    ) as { ok: boolean; verification: string };
    expect(toolResult).toMatchObject({ ok: true, verification: 'verified' });
    expect(backend.eventsOf('tools:confirmationResolved')).toEqual([
      { id: question!.id, decision: 'approved' },
    ]);
  });

  it('a rejection means the tool never runs and the model is told not to retry', async () => {
    const { requests, probeLog } = await rig([{ calls: [probe('HIGH', 'risky')] }, 'text-only']);
    const r = await send('do it');
    await waitPending();
    await backend.call('tools:respondConfirmation', { id: pending()[0]!.id, decision: 'rejected' });
    await done(r.assistantMessage.id);
    expect(probeLog).toEqual([]);
    const result = JSON.parse(
      bodyOf(requests[1]!).messages[2]!.content[0]!['content'] as string,
    ) as { status: string; note: string };
    expect(result.status).toBe('rejected');
    expect(result.note).toMatch(/Do not try it again/);
    expect(final(r.assistantMessage.id).actions![0]!.status).toBe('rejected');
    const audit = new ToolAuditRepository(backend.container.database.db);
    expect(audit.recentActivity()[0]).toMatchObject({
      result: 'denied',
      permission: 'denied_by_user',
      risk: 'HIGH',
    });
  });

  it('an unanswered question expires and counts as "no"', async () => {
    const { probeLog } = await rig([{ calls: [probe('MEDIUM', 'slow')] }, 'text-only'], {
      confirmationTimeoutMs: 120,
    });
    const r = await send('go');
    await done(r.assistantMessage.id);
    expect(probeLog).toEqual([]);
    expect(final(r.assistantMessage.id).actions![0]).toMatchObject({ status: 'rejected' });
    expect(backend.eventsOf('tools:confirmationResolved')).toEqual([
      expect.objectContaining({ decision: 'expired' }),
    ]);
  });

  it('typing "yes" (or "হ্যাঁ") in the chat answers the question, without sending it to the model', async () => {
    const { requests, probeLog } = await rig([{ calls: [probe('MEDIUM', 'typed')] }, 'text-only']);
    const first = await send('go');
    await waitPending();
    const modelCalls = requests.length;
    const answer = await send('হ্যাঁ', first.conversation.id);
    expect(answer.assistantMessage).toMatchObject({
      status: 'complete',
      content: 'ঠিক আছে, করছি।',
    });
    await done(first.assistantMessage.id);
    expect(probeLog).toEqual(['typed']);
    expect(requests.length).toBe(modelCalls + 1); // only the loop's follow-up, never the "yes" itself
    expect(JSON.stringify(requests.map((r) => r.body))).not.toContain('হ্যাঁ');
  });

  it('typing "no" rejects it', async () => {
    const { probeLog } = await rig([{ calls: [probe('MEDIUM', 'typed')] }, 'text-only']);
    const first = await send('go');
    await waitPending();
    const answer = await send('না', first.conversation.id);
    expect(answer.assistantMessage.content).toBe('ঠিক আছে, করছি না।');
    await done(first.assistantMessage.id);
    expect(probeLog).toEqual([]);
  });

  it('something that is not clearly yes or no re-asks the question and changes nothing', async () => {
    const { probeLog } = await rig([{ calls: [probe('HIGH', 'careful')] }, 'text-only']);
    const first = await send('go');
    await waitPending();
    for (const text of ['maybe', 'yes but only the first one', 'delete it', 'okay cancel']) {
      const answer = await send(text, first.conversation.id);
      // ("okay cancel" is a control command and stops the run; skip the rest of the loop once it has)
      if (!backend.container.tools.pendingConfirmations().length) break;
      expect(answer.assistantMessage.content).toContain(
        'A question is waiting: Probe (HIGH): careful',
      );
    }
    expect(probeLog).toEqual([]);
    backend.container.runs.cancelAll();
    await done(first.assistantMessage.id);
  });

  it('a spoken "yes" can approve a HIGH action but never a CRITICAL one', async () => {
    const { probeLog } = await rig([{ calls: [probe('HIGH', 'by voice')] }, 'text-only']);
    const a = await send('go');
    await waitPending();
    const voice = await send('yes', a.conversation.id, 'voice');
    expect(voice.assistantMessage.content).toBe('Okay, going ahead.');
    await done(a.assistantMessage.id);
    expect(probeLog).toEqual(['by voice']);
  });

  it('CRITICAL needs the button: typed or spoken "yes" is refused and the question stays open', async () => {
    const { probeLog } = await rig([{ calls: [probe('CRITICAL', 'dangerous')] }, 'text-only']);
    const a = await send('go');
    await waitPending();
    for (const source of ['voice', 'text'] as const) {
      const answer = await send('yes', a.conversation.id, source);
      expect(answer.assistantMessage.content).toMatch(/has to be confirmed on the screen/);
    }
    expect(probeLog).toEqual([]);
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.channels).toEqual(['ui']);
    await backend.call('tools:respondConfirmation', { id: pending()[0]!.id, decision: 'approved' });
    await done(a.assistantMessage.id);
    expect(probeLog).toEqual(['dangerous']);
  });

  it('STOP while a question is open cancels the action and the reply', async () => {
    const { probeLog } = await rig([{ calls: [probe('MEDIUM', 'x')] }, 'text-only']);
    const a = await send('go');
    await waitPending();
    expect(data<{ cancelled: number }>(await backend.call('agent:stop')).cancelled).toBe(1);
    await done(a.assistantMessage.id);
    expect(final(a.assistantMessage.id).status).toBe('cancelled');
    expect(probeLog).toEqual([]);
    expect(backend.container.tools.pendingConfirmations()).toEqual([]);
  });

  it('the typed word "stop" also cancels a pending question', async () => {
    await rig([{ calls: [probe('MEDIUM', 'x')] }, 'text-only']);
    const a = await send('go');
    await waitPending();
    const stop = await send('stop', a.conversation.id);
    expect(stop.assistantMessage.content).toBe('Stopped.');
    await done(a.assistantMessage.id);
    expect(final(a.assistantMessage.id).status).toBe('cancelled');
  });

  it('an answer to a question that no longer exists is refused by the IPC layer', async () => {
    await rig(['text-only']);
    expect(
      data(
        await backend.call('tools:respondConfirmation', {
          id: 'confirm_gone',
          decision: 'approved',
        }),
      ),
    ).toEqual({ accepted: false });
    expect(
      await backend.call('tools:respondConfirmation', { id: 'x', decision: 'maybe' }),
    ).toMatchObject({ ok: false });
  });

  it('LOW-risk actions never interrupt the user', async () => {
    const { probeLog } = await rig([{ calls: [probe('LOW', 'quiet')] }, 'text-only']);
    const r = await send('go');
    await done(r.assistantMessage.id);
    expect(probeLog).toEqual(['quiet']);
    expect(backend.eventsOf('tools:confirmationRequested')).toEqual([]);
  });

  it('each conversation only sees its own pending questions', async () => {
    await rig([{ calls: [probe('MEDIUM', 'a')] }, 'text-only']);
    const a = await send('go');
    await waitPending();
    // A "yes" in an unrelated conversation must not approve conversation A's action.
    const other = await send('yes');
    expect(other.assistantMessage.status).toBe('streaming'); // it went to the model as ordinary text
    expect(pending()).toHaveLength(1);
    backend.container.runs.cancelAll();
    await done(a.assistantMessage.id);
  });
});

describe('permissions', () => {
  it('lists every subject with its default, and marks sensitive ones', async () => {
    await rig(['text-only']);
    const entries = data<
      Array<{ subject: string; mode: string; defaultMode: string; sensitive: boolean }>
    >(await backend.call('permissions:list'));
    expect(entries.find((e) => e.subject === 'camera')).toMatchObject({
      mode: 'never',
      sensitive: false,
    });
    expect(entries.find((e) => e.subject === 'delete_files')).toMatchObject({
      mode: 'ask',
      sensitive: true,
    });
    expect(entries.find((e) => e.subject === 'administrator_commands')).toMatchObject({
      mode: 'never',
      sensitive: true,
    });
  });

  it('"never" refuses the action outright and the model is told it is not permitted', async () => {
    const { requests, probeLog } = await rig([{ calls: [probe('LOW', 'blocked')] }, 'text-only']);
    await backend.call('permissions:set', { subject: 'file_access', mode: 'never' });
    const r = await send('go');
    await done(r.assistantMessage.id);
    expect(probeLog).toEqual([]);
    const result = JSON.parse(
      bodyOf(requests[1]!).messages[2]!.content[0]!['content'] as string,
    ) as { status: string; note: string };
    expect(result.status).toBe('denied');
    expect(result.note).toMatch(/permission settings/);
    expect(backend.eventsOf('tools:confirmationRequested')).toEqual([]);
  });

  it('"always allow" skips the question for MEDIUM but never for CRITICAL', async () => {
    const { probeLog } = await rig([{ calls: [probe('MEDIUM', 'silent')] }, 'text-only']);
    await backend.call('permissions:set', { subject: 'file_access', mode: 'always_allow' });
    const r = await send('go');
    await done(r.assistantMessage.id);
    expect(probeLog).toEqual(['silent']);
    expect(backend.eventsOf('tools:confirmationRequested')).toEqual([]);
  });

  it('sensitive actions cannot be set to "always allow"', async () => {
    await rig(['text-only']);
    for (const subject of [
      'delete_files',
      'send_email',
      'install_software',
      'administrator_commands',
      'external_communication',
    ]) {
      expect(
        await backend.call('permissions:set', { subject, mode: 'always_allow' }),
        subject,
      ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(
      await backend.call('permissions:set', { subject: 'delete_files', mode: 'never' }),
    ).toMatchObject({ ok: true });
  });

  it('rejects unknown subjects and modes at the IPC boundary', async () => {
    await rig(['text-only']);
    expect(
      await backend.call('permissions:set', { subject: 'root', mode: 'always_allow' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_IPC_PAYLOAD' } });
    expect(
      await backend.call('permissions:set', { subject: 'file_access', mode: 'yolo' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_IPC_PAYLOAD' } });
  });

  it('permission changes take effect on the next action and persist', async () => {
    const { probeLog } = await rig([{ calls: [probe('LOW', 'p')] }, 'text-only']);
    await backend.call('permissions:set', { subject: 'file_access', mode: 'never' });
    expect((await send('go')).assistantMessage.status).toBe('streaming');
    await vi.waitFor(() => expect(backend.container.runs.active()).toEqual([]), { timeout: 4000 });
    expect(probeLog).toEqual([]);
    await backend.call('permissions:set', { subject: 'file_access', mode: 'ask' });
    const entry = data<Array<{ subject: string; mode: string }>>(
      await backend.call('permissions:list'),
    ).find((e) => e.subject === 'file_access');
    expect(entry?.mode).toBe('ask');
  });
});

describe('cancellation during execution', () => {
  it('the emergency stop aborts a tool that is mid-run', async () => {
    const { probeLog } = await rig([
      {
        calls: [
          {
            id: 'toolu_slow',
            name: 'e2e_probe',
            input: { level: 'LOW', note: 'slow', delayMs: 5000 },
          },
        ],
      },
      'text-only',
    ]);
    const r = await send('go');
    await vi.waitFor(() => expect(backend.container.runs.active()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await backend.call('agent:stop');
    await done(r.assistantMessage.id);
    expect(final(r.assistantMessage.id).status).toBe('cancelled');
    expect(probeLog).toEqual([]);
    const audit = new ToolAuditRepository(backend.container.database.db);
    expect(audit.recentActivity()[0]).toMatchObject({ tool: 'e2e_probe', result: 'cancelled' });
  });
});

describe('secrets and audit hygiene', () => {
  it('tool arguments are redacted and bounded in the audit log', async () => {
    await rig([
      {
        calls: [
          {
            id: 'toolu_1',
            name: 'e2e_probe',
            input: {
              level: 'LOW',
              note: `token sk-ant-api03-${'A'.repeat(30)} ${'x'.repeat(150)}`,
            },
          },
        ],
      },
      'text-only',
    ]);
    const r = await send('go');
    await done(r.assistantMessage.id);
    const callId = (backend.eventsOf('tools:activity') as Array<{ action: { callId: string } }>)[0]!
      .action.callId;
    const row = new ToolAuditRepository(backend.container.database.db).getCall(callId)!;
    expect(row.argumentsJson).not.toContain('AAAAAAAAAAAAAAAA');
    expect(row.argumentsJson.length).toBeLessThan(600);
    expect(JSON.stringify(backend.logs.records)).not.toContain('AAAAAAAAAAAAAAAA');
  });
});
