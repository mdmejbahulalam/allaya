import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@allaya/ai';
import type { ChatView, ConnectionView, MessageView, ModelRef } from '@lite/shared/ipc';
import { buildSystemPrompt } from '@lite/main/core/prompt';
import type { Tool } from '@lite/main/core/tools';
import { API_KEY, SONNET, hangingStream, modelsResponse } from '../helpers/anthropic';
import { aiCall, fakeAi, type FakeAi, type FakeAiScript } from '../helpers/fake-ai';
import { json } from '../helpers/fetch';
import { createLiteBackend, data, failure, type LiteBackend } from './helpers/backend';

const backends: LiteBackend[] = [];
afterEach(() => {
  for (const b of backends.splice(0)) b.dispose();
});

async function rig(
  script: FakeAiScript = {},
  options: Parameters<typeof createLiteBackend>[0] = {},
) {
  const ai: FakeAi = fakeAi(script);
  const b = createLiteBackend({ fetch: ai.fetch, ...options });
  backends.push(b);
  const connection = data<ConnectionView>(
    await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY }),
  );
  const model: ModelRef = { connectionId: connection.id, modelId: SONNET };
  return { b, ai, connection, model };
}

type Sent = { chat: ChatView; userMessage: MessageView; reply: MessageView };
const send = async (
  b: LiteBackend,
  text: string,
  extra: { chatId?: string; model?: ModelRef } = {},
) => data<Sent>(await b.call('chat:send', { text, ...extra }));
const idle = (b: LiteBackend) => b.chat.whenIdle();
const messages = async (b: LiteBackend, chatId: string) =>
  data<{ chat: ChatView; messages: MessageView[] }>(await b.call('chats:get', { id: chatId }))
    .messages;
/** Who said what, whether the provider sent the text plain or in parts. */
const said = (list: Array<{ role: string; content: unknown }>) =>
  list.map((m) => [
    m.role,
    typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ text?: string }>).map((p) => p.text ?? '').join(''),
  ]);
const bodyOf = (call: FakeAi['calls'][number]) =>
  call.request.body as {
    system: string;
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ name: string }>;
  };

describe('sending a message', () => {
  it('saves both messages, streams the reply as it is written, and finishes it', async () => {
    const { b, model } = await rig({ chat: [{ text: ['Hel', 'lo ', 'there.'] }] });
    const sent = await send(b, 'Say hello', { model });
    expect(sent.userMessage).toMatchObject({
      role: 'user',
      content: 'Say hello',
      status: 'complete',
    });
    expect(sent.reply).toMatchObject({
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: 'Claude Sonnet 5.5',
    });
    await idle(b);
    const [, reply] = await messages(b, sent.chat.id);
    expect(reply).toMatchObject({ content: 'Hello there.', status: 'complete' });
    expect(
      b.events
        .of('chat:delta')
        .map((d) => d.text)
        .join(''),
    ).toBe('Hello there.');
    expect(b.events.of('chat:delta').every((d) => d.messageId === sent.reply.id)).toBe(true);
    expect(b.events.of('chat:message').at(-1)).toMatchObject({
      id: sent.reply.id,
      status: 'complete',
    });
  });

  it('titles a new chat from its first message, and lists the newest first', async () => {
    const { b, model } = await rig({ chat: [{ text: ['One.'] }, { text: ['Two.'] }] });
    const first = await send(b, 'Plan   my\nweek please', { model });
    await idle(b);
    const second = await send(b, 'x'.repeat(100), { model });
    await idle(b);
    const list = data<ChatView[]>(await b.call('chats:list'));
    expect(list.map((c) => c.id)).toEqual([second.chat.id, first.chat.id]);
    expect(list[1]!.title).toBe('Plan my week please');
    expect(list[0]!.title).toBe(`${'x'.repeat(48)}…`);
  });

  it('keeps the conversation: the model sees what was said before', async () => {
    const { b, ai, model } = await rig({ chat: [{ text: ['Blue.'] }, { text: ['Because.'] }] });
    const first = await send(b, 'Favourite colour?', { model });
    await idle(b);
    await send(b, 'Why?', { chatId: first.chat.id });
    await idle(b);
    expect(said(bodyOf(ai.calls[1]!).messages)).toEqual([
      ['user', 'Favourite colour?'],
      ['assistant', 'Blue.'],
      ['user', 'Why?'],
    ]);
  });

  it('tells the model who it is, who the person is, and what they asked for', async () => {
    const { b, ai, model } = await rig(
      { chat: [{ text: ['ok'] }] },
      { now: () => new Date(2026, 9, 10, 8, 30) },
    );
    await b.call('settings:set', { userName: 'Babul', instructions: 'Answer in short lines.' });
    b.tools.unregisterPrefix('');
    await send(b, 'Hi', { model });
    await idle(b);
    const system = bodyOf(ai.calls[0]!).system;
    expect(system).toContain('Allaya (আলেয়া)');
    expect(system).toContain("The user's name is Babul.");
    expect(system).toContain('Answer in short lines.');
    expect(system).toContain('2026-10-10, 08:30');
    expect(system).toContain('no tools');
  });

  it('chooses the model: the one asked for, else the chat’s, else the default, else the first available', async () => {
    const { b, ai, connection } = await rig({
      chat: [{ text: ['a'] }, { text: ['b'] }, { text: ['c'] }, { text: ['d'] }],
    });
    const used = () => ai.calls.map((c) => (c.request.body as { model: string }).model);
    const haiku: ModelRef = { connectionId: connection.id, modelId: 'claude-haiku-4-5-20251001' };
    // Nothing chosen: the first the service lists.
    const first = await send(b, '1');
    await idle(b);
    expect(first.chat.model).toEqual({ connectionId: connection.id, modelId: expect.any(String) });
    // The chat remembers it.
    await send(b, '2', { chatId: first.chat.id });
    await idle(b);
    expect(used()[1]).toBe(used()[0]);
    // A new chat gets the default.
    await b.call('settings:set', { defaultModel: haiku });
    const second = await send(b, '3');
    await idle(b);
    expect(used()[2]).toBe(haiku.modelId);
    expect(second.chat.model).toEqual(haiku);
    // Asking for one overrides, and sticks.
    const third = await send(b, '4', {
      chatId: second.chat.id,
      model: { connectionId: connection.id, modelId: SONNET },
    });
    await idle(b);
    expect(used()[3]).toBe(SONNET);
    expect(third.chat.model?.modelId).toBe(SONNET);
  });

  it('says what to do when no service is connected, and saves nothing', async () => {
    const b = createLiteBackend();
    backends.push(b);
    const result = await b.call('chat:send', { text: 'Hello' });
    expect(failure(result)).toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      details: { reason: 'no_model' },
    });
    expect(data<ChatView[]>(await b.call('chats:list'))).toEqual([]);
  });

  it('a connected service that cannot be read says why, not that nothing is connected', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(json({ error: { message: 'bad key' } }, { status: 401 }));
    const b = createLiteBackend({ fetch });
    backends.push(b);
    await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY });
    const result = await b.call('chat:send', { text: 'Hello' });
    expect(failure(result).code).toBe('PROVIDER_AUTH_FAILED');
    expect(data<ChatView[]>(await b.call('chats:list'))).toEqual([]);
  });

  it('refuses empty or oversized text, and a chat that does not exist', async () => {
    const { b, model } = await rig();
    expect(failure(await b.call('chat:send', { text: '   ', model })).code).toBe(
      'INVALID_IPC_PAYLOAD',
    );
    expect(failure(await b.call('chat:send', { text: 'x'.repeat(30_001), model })).code).toBe(
      'INVALID_IPC_PAYLOAD',
    );
    expect(failure(await b.call('chat:send', { text: 'hi', chatId: 'nope', model })).code).toBe(
      'NOT_FOUND',
    );
  });
});

describe('a reply that does not finish normally', () => {
  /** A model that writes a little and then waits, until it is stopped. */
  const slow =
    (written: string): FetchLike =>
    (url, init) => {
      if (url.includes('/v1/models')) return Promise.resolve(modelsResponse());
      return Promise.resolve(hangingStream(written, init?.signal ?? undefined));
    };

  async function slowRig() {
    const b = createLiteBackend({ fetch: slow('Half an ans') });
    backends.push(b);
    const connection = data<ConnectionView>(
      await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY }),
    );
    return { b, model: { connectionId: connection.id, modelId: SONNET } };
  }

  it('can be stopped, keeping what had been written', async () => {
    const { b, model } = await slowRig();
    const sent = await send(b, 'Tell me a lot', { model });
    await vi.waitFor(() => expect(b.events.of('chat:delta').length).toBeGreaterThan(0));
    await b.call('chat:cancel', { chatId: sent.chat.id });
    await idle(b);
    const [, reply] = await messages(b, sent.chat.id);
    expect(reply).toMatchObject({ status: 'cancelled', content: 'Half an ans' });
    expect(reply!.error).toBeUndefined();
  });

  it('allows one reply at a time in a chat', async () => {
    const { b, model } = await slowRig();
    const sent = await send(b, 'First', { model });
    const second = await b.call('chat:send', { text: 'Second', chatId: sent.chat.id });
    expect(failure(second)).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { reason: 'busy' } });
    await b.call('chat:cancel', { chatId: sent.chat.id });
    await idle(b);
    expect(await messages(b, sent.chat.id)).toHaveLength(2);
  });

  it('is marked stopped, with its text, if the app was closed while it was being written', async () => {
    const { b, model } = await slowRig();
    const sent = await send(b, 'Go on', { model });
    await vi.waitFor(() => expect(b.events.of('chat:delta').length).toBeGreaterThan(0));
    b.chat.cancel(sent.chat.id);
    await idle(b);
    // As if the app had been killed: the saved text is there, but nothing finished the reply.
    b.db
      .prepare("update messages set content = 'saved part', status = 'streaming' where id = ?")
      .run(sent.reply.id);
    b.chat.recoverInterrupted();
    expect((await messages(b, sent.chat.id))[1]).toMatchObject({
      status: 'cancelled',
      content: 'saved part',
    });
  });

  it('a failure is shown with its reason — and never carries the key', async () => {
    const fetch: FetchLike = (url) =>
      Promise.resolve(
        url.includes('/v1/models')
          ? modelsResponse()
          : json({ error: { message: `bad key ${API_KEY}` } }, { status: 401 }),
      );
    const b = createLiteBackend({ fetch });
    backends.push(b);
    const connection = data<ConnectionView>(
      await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY }),
    );
    const sent = await send(b, 'Hi', { model: { connectionId: connection.id, modelId: SONNET } });
    await idle(b);
    const [, reply] = await messages(b, sent.chat.id);
    expect(reply).toMatchObject({ status: 'error', error: { code: 'PROVIDER_AUTH_FAILED' } });
    expect(JSON.stringify(reply)).not.toContain(API_KEY);
  });

  it('a failed reply is left out of what the model sees next, and the person’s turns are joined', async () => {
    const calls: unknown[] = [];
    let n = 0;
    const fetch: FetchLike = (url, init) => {
      if (url.includes('/v1/models')) return Promise.resolve(modelsResponse());
      calls.push(JSON.parse(init?.body as string));
      n += 1;
      return Promise.resolve(
        n === 1
          ? json({ error: { message: 'bad request' } }, { status: 400 })
          : fakeAi({ chat: [{ text: ['Fine now.'] }] }).fetch(url, init),
      );
    };
    const b = createLiteBackend({ fetch });
    backends.push(b);
    const connection = data<ConnectionView>(
      await b.call('connections:add', { presetId: 'anthropic', apiKey: API_KEY }),
    );
    const model = { connectionId: connection.id, modelId: SONNET };
    const first = await send(b, 'Question one', { model });
    await idle(b);
    expect((await messages(b, first.chat.id))[1]!.status).toBe('error');
    await send(b, 'Question two', { chatId: first.chat.id });
    await idle(b);
    expect(
      said((calls[1] as { messages: Array<{ role: string; content: unknown }> }).messages),
    ).toEqual([['user', 'Question one\n\nQuestion two']]);
  }, 20_000);

  it('a reply that failed part-way is not shown to the model as if it had been said', async () => {
    const { b, ai, model } = await rig({ chat: [{ text: ['Fine.'] }] });
    const chat = data<ChatView>(await b.call('chats:create', {}));
    b.db
      .prepare(
        `insert into messages (id, chat_id, role, content, status, created_at) values
         ('u0', ?, 'user', 'First question', 'complete', 1),
         ('a0', ?, 'assistant', 'A half-written answ', 'error', 1)`,
      )
      .run(chat.id, chat.id);
    await send(b, 'Second question', { chatId: chat.id, model });
    await idle(b);
    expect(said(bodyOf(ai.calls[0]!).messages)).toEqual([
      ['user', 'First question\n\nSecond question'],
    ]);
  });

  it('an empty reply is an error, not a blank bubble', async () => {
    const { b, model } = await rig({ chat: [{ text: [] }] });
    const sent = await send(b, 'Hi', { model });
    await idle(b);
    expect((await messages(b, sent.chat.id))[1]).toMatchObject({
      status: 'error',
      error: { code: 'PROVIDER_ERROR' },
    });
  });
});

describe('managing chats', () => {
  it('creates, renames, changes the model of, and deletes a chat with its messages', async () => {
    const { b, model } = await rig({ chat: [{ text: ['hi'] }] });
    const chat = data<ChatView>(await b.call('chats:create', {}));
    expect(chat).toMatchObject({ title: 'New chat', model: null });
    expect(data<ChatView>(await b.call('chats:rename', { id: chat.id, title: 'Trip' })).title).toBe(
      'Trip',
    );
    expect(data<ChatView>(await b.call('chats:setModel', { id: chat.id, model })).model).toEqual(
      model,
    );
    await send(b, 'hello', { chatId: chat.id });
    await idle(b);
    expect((await messages(b, chat.id)).length).toBe(2);
    expect(
      ((await b.call('chats:rename', { id: chat.id, title: '  ' })) as { ok: boolean }).ok,
    ).toBe(false);
    expect(data(await b.call('chats:remove', { id: chat.id }))).toEqual({ ok: true });
    expect(b.db.prepare('select count(*) as n from messages').get()).toEqual({ n: 0 });
    expect(failure(await b.call('chats:get', { id: chat.id })).code).toBe('NOT_FOUND');
  });

  it('a new chat starts with the default model', async () => {
    const { b, model } = await rig();
    await b.call('settings:set', { defaultModel: model });
    expect(data<ChatView>(await b.call('chats:create', {})).model).toEqual(model);
  });

  it('deleting a chat that is being answered stops the answer', async () => {
    const { b, model } = await rig({ chat: ['hang'] });
    const sent = await send(b, 'Hi', { model });
    await b.call('chats:remove', { id: sent.chat.id });
    await idle(b);
    expect(data<ChatView[]>(await b.call('chats:list'))).toEqual([]);
  });
});

describe('tools in a chat', () => {
  const lookup: Tool = {
    name: 'lookup',
    description: 'Looks something up',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    effect: 'read',
    summarize: (args) => `Look up: ${String(args['q'])}`,
    run: (args) => Promise.resolve(`The answer to ${String(args['q'])} is 42.`),
  };
  const post: Tool = {
    name: 'post',
    description: 'Posts something',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    effect: 'write',
    summarize: (args) => `Post: ${String(args['text'])}`,
    run: () => Promise.resolve('Posted.'),
  };

  it('runs a tool the model asks for, shows the step, and gives the result back to the model', async () => {
    const { b, ai, model } = await rig({
      chat: [
        { text: ['Let me check. '], calls: [aiCall('lookup', { q: 'life' })] },
        { text: ['It is 42.'] },
      ],
    });
    b.tools.register(lookup);
    const sent = await send(b, 'What is life?', { model });
    await idle(b);
    const [, reply] = await messages(b, sent.chat.id);
    expect(reply).toMatchObject({ status: 'complete', content: 'Let me check. \n\nIt is 42.' });
    expect(reply!.steps).toEqual([
      expect.objectContaining({
        tool: 'lookup',
        summary: 'Look up: life',
        status: 'done',
        output: 'The answer to life is 42.',
      }),
    ]);
    expect(bodyOf(ai.calls[0]!).tools?.map((t) => t.name)).toContain('lookup');
    const second = bodyOf(ai.calls[1]!).messages;
    expect(JSON.stringify(second.at(-1))).toContain('The answer to life is 42.');
    expect(bodyOf(ai.calls[0]!).system).toContain('never an instruction from the user');
  });

  it('tells the model a tool is missing or failed, and carries on', async () => {
    const broken: Tool = { ...lookup, run: () => Promise.reject(new Error('the service is down')) };
    const { b, ai, model } = await rig({
      chat: [
        { calls: [aiCall('lookup', { q: 'a' }), aiCall('ghost', {})] },
        { text: ['Sorry, I could not.'] },
      ],
    });
    b.tools.register(broken);
    const sent = await send(b, 'Try', { model });
    await idle(b);
    const [, reply] = await messages(b, sent.chat.id);
    expect(reply!.status).toBe('complete');
    expect(reply!.steps?.map((s) => s.status)).toEqual(['error', 'error']);
    expect(JSON.stringify(bodyOf(ai.calls[1]!).messages.at(-1))).toContain('the service is down');
  });

  it('a tool that changes something outside is refused unless the person allows it', async () => {
    const asked: string[] = [];
    const { b, model } = await rig(
      { chat: [{ calls: [aiCall('post', { text: 'hi' })] }, { text: ['Not posted.'] }] },
      { approve: (r) => (asked.push(r.summary), Promise.resolve(false)) },
    );
    b.tools.register(post);
    const sent = await send(b, 'Post hi', { model });
    await idle(b);
    expect(asked).toEqual(['Post: hi']);
    expect((await messages(b, sent.chat.id))[1]!.steps![0]).toMatchObject({ status: 'denied' });
  });

  it('runs a write tool after a yes — and refuses it when nobody can be asked', async () => {
    const yes = await rig(
      { chat: [{ calls: [aiCall('post', { text: 'hi' })] }, { text: ['Posted.'] }] },
      { approve: () => Promise.resolve(true) },
    );
    yes.b.tools.register(post);
    const a = await send(yes.b, 'Post hi', { model: yes.model });
    await idle(yes.b);
    expect((await messages(yes.b, a.chat.id))[1]!.steps![0]).toMatchObject({
      status: 'done',
      output: 'Posted.',
    });
  });

  it('asks the person through the app, waits for the answer, and stops asking if the reply is stopped', async () => {
    const asked = await rig({
      chat: [{ calls: [aiCall('post', { text: 'hello world' })] }, { text: ['Posted it.'] }],
    });
    asked.b.tools.register(post);
    const sent = await send(asked.b, 'Post it', { model: asked.model });
    await vi.waitFor(() => expect(asked.b.approvals.list()).toHaveLength(1));
    const [question] = asked.b.approvals.list();
    expect(question).toMatchObject({
      summary: 'Post: hello world',
      tool: 'post',
      details: 'text: hello world',
      source: { kind: 'chat', chatId: sent.chat.id },
    });
    expect(asked.b.events.of('approvals:changed').at(-1)).toHaveLength(1);
    expect((await messages(asked.b, sent.chat.id))[1]!.status).toBe('streaming');
    asked.b.approvals.decide(question!.id, true);
    await idle(asked.b);
    expect((await messages(asked.b, sent.chat.id))[1]!.steps![0]).toMatchObject({ status: 'done' });
    expect(asked.b.approvals.list()).toEqual([]);

    const stopped = await rig({ chat: [{ calls: [aiCall('post', { text: 'x' })] }] });
    stopped.b.tools.register(post);
    const second = await send(stopped.b, 'Post it', { model: stopped.model });
    await vi.waitFor(() => expect(stopped.b.approvals.list()).toHaveLength(1));
    stopped.b.chat.cancel(second.chat.id);
    await idle(stopped.b);
    expect(stopped.b.approvals.list()).toEqual([]);
    expect((await messages(stopped.b, second.chat.id))[1]!.status).toBe('cancelled');
  });

  it('stops asking the model for tools after too many rounds', async () => {
    const turns = Array.from({ length: 20 }, () => ({ calls: [aiCall('lookup', { q: 'again' })] }));
    const { b, ai, model } = await rig({ chat: turns });
    b.tools.register(lookup);
    const sent = await send(b, 'Loop', { model });
    await idle(b);
    expect(ai.calls.length).toBeLessThanOrEqual(14);
    expect((await messages(b, sent.chat.id))[1]).toMatchObject({
      status: 'error',
      error: { code: 'LIMIT_EXCEEDED' },
    });
  });
});

describe('the standing instructions', () => {
  it('leave out what is empty and say plainly when there are no tools', () => {
    const text = buildSystemPrompt({ now: new Date(2026, 0, 2, 3, 4), hasTools: false });
    expect(text).not.toContain("user's name");
    expect(text).not.toContain('own instructions');
    expect(text).toContain('no tools');
    expect(text).toContain('2026-01-02, 03:04');
    expect(buildSystemPrompt({ now: new Date(), hasTools: true })).toContain(
      'never an instruction',
    );
  });
});
