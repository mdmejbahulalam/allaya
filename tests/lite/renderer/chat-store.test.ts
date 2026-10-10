import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@lite/renderer/src/stores/chat';
import { bridge, message, resetStores } from './helpers';

const chat = (over = {}) => ({
  id: 'chat1',
  title: 'T',
  model: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  resetStores();
});

describe('sending from the screen', () => {
  it('starts a new chat from the first message and shows both messages', async () => {
    const invoke = bridge({
      'chat:send': () => ({
        chat: chat(),
        userMessage: message({ id: 'u1', role: 'user', content: 'Hi' }),
        reply: message({ id: 'r1', status: 'streaming' }),
      }),
      'chats:list': () => [chat()],
    });
    await useChatStore.getState().send('Hi');
    const state = useChatStore.getState();
    expect(state.activeId).toBe('chat1');
    expect(state.messages.map((m) => m.id)).toEqual(['u1', 'r1']);
    expect(invoke).toHaveBeenCalledWith('chat:send', { text: 'Hi' });
    expect(state.chats).toHaveLength(1);
  });

  it('adds to an open chat, and a model picked before the chat began is used once', async () => {
    const invoke = bridge({
      'chat:send': () => ({
        chat: chat(),
        userMessage: message({ id: 'u2', role: 'user', content: 'Again' }),
        reply: message({ id: 'r2', status: 'streaming' }),
      }),
    });
    useChatStore.setState({ pendingModel: { connectionId: 'c1', modelId: 'm' } });
    await useChatStore.getState().send('First');
    expect(invoke).toHaveBeenCalledWith('chat:send', {
      text: 'First',
      model: { connectionId: 'c1', modelId: 'm' },
    });
    expect(useChatStore.getState().pendingModel).toBeNull();
    useChatStore.setState({ activeId: 'chat1', messages: [message({ id: 'old' })] });
    await useChatStore.getState().send('Again');
    expect(invoke).toHaveBeenCalledWith('chat:send', { text: 'Again', chatId: 'chat1' });
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['old', 'u2', 'r2']);
  });

  it('a failed send throws, and shows nothing', async () => {
    bridge({
      'chat:send': () => {
        throw Object.assign(new Error('x'), { code: 'PROVIDER_NOT_CONFIGURED' });
      },
    });
    await expect(useChatStore.getState().send('Hi')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
    expect(useChatStore.getState().messages).toEqual([]);
  });
});

describe('a reply arriving as it is written', () => {
  const open = () =>
    useChatStore.setState({
      activeId: 'chat1',
      messages: [message({ id: 'r1', status: 'streaming', content: 'He' })],
    });

  it('grows with each piece and is replaced by the finished message', () => {
    open();
    const { onDelta, onMessage } = useChatStore.getState();
    onDelta({ chatId: 'chat1', messageId: 'r1', text: 'llo' });
    expect(useChatStore.getState().messages[0]!.content).toBe('Hello');
    onMessage(message({ id: 'r1', content: 'Hello!', status: 'complete' }));
    expect(useChatStore.getState().messages[0]).toMatchObject({
      content: 'Hello!',
      status: 'complete',
    });
  });

  it('ignores another chat’s pieces', () => {
    open();
    useChatStore.getState().onDelta({ chatId: 'other', messageId: 'zz', text: 'no' });
    useChatStore.getState().onMessage(message({ id: 'zz', chatId: 'other', content: 'no' }));
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0]!.content).toBe('He');
  });

  it('keeps pieces that arrive before the answer to "send", in order, and applies them to the reply', async () => {
    // A fast model: the pieces and the finished message are announced before the call has returned.
    const store = useChatStore.getState();
    store.onDelta({ chatId: 'chat1', messageId: 'r9', text: 'Qu' });
    store.onDelta({ chatId: 'chat1', messageId: 'r9', text: 'ick' });
    bridge({
      'chat:send': () => ({
        chat: chat(),
        userMessage: message({ id: 'u9', role: 'user', content: 'Hi' }),
        reply: message({ id: 'r9', status: 'streaming' }),
      }),
    });
    await useChatStore.getState().send('Hi');
    expect(useChatStore.getState().messages[1]).toMatchObject({
      id: 'r9',
      content: 'Quick',
      status: 'streaming',
    });
  });

  it('a finished message that arrived early is not left "streaming" forever', async () => {
    useChatStore.getState().onMessage(message({ id: 'r8', content: 'Done.', status: 'complete' }));
    bridge({
      'chat:send': () => ({
        chat: chat(),
        userMessage: message({ id: 'u8', role: 'user', content: 'Hi' }),
        reply: message({ id: 'r8', status: 'streaming' }),
      }),
    });
    await useChatStore.getState().send('Hi');
    expect(useChatStore.getState().messages[1]).toMatchObject({
      content: 'Done.',
      status: 'complete',
    });
  });
});

describe('the chats on the side', () => {
  it('opens one, starts a new one, and deleting the open one leaves a new chat', async () => {
    bridge({
      'chats:get': () => ({ chat: chat(), messages: [message({ id: 'x', content: 'hello' })] }),
      'chats:list': () => [],
    });
    await useChatStore.getState().open('chat1');
    expect(useChatStore.getState()).toMatchObject({ activeId: 'chat1' });
    expect(useChatStore.getState().messages).toHaveLength(1);
    await useChatStore.getState().remove('chat1');
    expect(useChatStore.getState()).toMatchObject({ activeId: null, messages: [] });
    useChatStore.setState({ pendingModel: { connectionId: 'a', modelId: 'b' } });
    useChatStore.getState().startNew();
    expect(useChatStore.getState().pendingModel).toBeNull();
  });

  it('choosing a model changes the open chat, or is remembered for the next one', async () => {
    const invoke = bridge({ 'chats:list': () => [] });
    const pick = { connectionId: 'c1', modelId: 'm1' };
    await useChatStore.getState().chooseModel(pick);
    expect(useChatStore.getState().pendingModel).toEqual(pick);
    expect(invoke).not.toHaveBeenCalledWith('chats:setModel', expect.anything());
    useChatStore.setState({ activeId: 'chat1' });
    await useChatStore.getState().chooseModel(pick);
    expect(invoke).toHaveBeenCalledWith('chats:setModel', { id: 'chat1', model: pick });
  });
});
