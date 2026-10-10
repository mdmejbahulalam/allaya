import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '@lite/renderer/src/components/composer';
import { ChatView } from '@lite/renderer/src/components/chat-view';
import { AssistantMessage } from '@lite/renderer/src/components/message';
import { ModelPicker } from '@lite/renderer/src/components/model-picker';
import { Sidebar } from '@lite/renderer/src/components/sidebar';
import { useAppStore } from '@lite/renderer/src/stores/app';
import { useChatStore } from '@lite/renderer/src/stores/chat';
import { useConnectionsStore } from '@lite/renderer/src/stores/connections';
import { bridge, message, model, renderLite, resetStores } from './helpers';

beforeEach(() => {
  resetStores();
  bridge();
});

const sonnet = { connectionId: 'c1', modelId: 'claude-sonnet' };

describe('the message box', () => {
  const setup = (over: Partial<Parameters<typeof Composer>[0]> = {}) => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onStop = vi.fn();
    renderLite(
      <Composer
        busy={false}
        disabled={false}
        model={sonnet}
        onModel={() => undefined}
        onSend={onSend}
        onStop={onStop}
        onConnect={() => undefined}
        autoFocusKey={null}
        {...over}
      />,
    );
    return { onSend, onStop, box: screen.getByRole('textbox', { name: 'Message Allaya…' }) };
  };

  it('sends on Enter and clears, but Shift+Enter only starts a new line', async () => {
    const { onSend, box } = setup();
    await userEvent.type(box, 'Hello{Shift>}{Enter}{/Shift}there');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('Hello\nthere');
    await userEvent.type(box, '{Enter}');
    expect(onSend).toHaveBeenCalledWith('Hello\nthere');
    expect(box).toHaveValue('');
  });

  it('does not send nothing, or while a reply is being written, or with nothing to talk to', async () => {
    const idle = setup();
    await userEvent.type(idle.box, '   {Enter}');
    expect(idle.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('while a reply is written the button is Stop', async () => {
    const { onStop, onSend, box } = setup({ busy: true });
    await userEvent.type(box, 'next{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('gives the text back when sending fails, so nothing typed is lost', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('no'));
    const { box } = setup({ onSend });
    await userEvent.type(box, 'keep me{Enter}');
    await waitFor(() => expect(box).toHaveValue('keep me'));
  });

  it('is turned off when no service is connected', async () => {
    const { onSend, box } = setup({ disabled: true });
    await userEvent.type(box, 'x{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('choosing a model', () => {
  const two = [
    model(),
    model({ modelId: 'claude-haiku', displayName: 'Claude Haiku' }),
    model({
      connectionId: 'c2',
      connectionName: 'Groq',
      modelId: 'llama-3.3-70b',
      displayName: 'llama-3.3-70b',
      inferred: true,
    }),
  ];

  it('shows the chosen model and lists every service’s models in groups', async () => {
    useConnectionsStore.setState({ models: two });
    renderLite(<ModelPicker value={sonnet} onPick={() => undefined} onConnect={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Model: Claude Sonnet' });
    expect(button).toHaveTextContent('Anthropic (Claude)');
    await userEvent.click(button);
    const list = screen.getByRole('listbox', { name: 'Choose a model' });
    expect(
      within(list)
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Anthropic (Claude)', 'Groq']);
    expect(within(list).getByRole('option', { name: /Claude Sonnet/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(list).getByRole('option', { name: 'llama-3.3-70b' })).toHaveAttribute(
      'title',
      'Details guessed from the name',
    );
  });

  it('picks, closes, and finds a model by part of its name or its service', async () => {
    useConnectionsStore.setState({ models: two });
    const onPick = vi.fn();
    renderLite(<ModelPicker value={sonnet} onPick={onPick} onConnect={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Search models' }), 'groq');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.click(screen.getByRole('option', { name: 'llama-3.3-70b' }));
    expect(onPick).toHaveBeenCalledWith({ connectionId: 'c2', modelId: 'llama-3.3-70b' });
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Search models' }), 'zzz');
    expect(screen.getByText('No model matches “zzz”.')).toBeVisible();
  });

  it('closes with Escape, and offers the way to connect when there are no models', async () => {
    const onConnect = vi.fn();
    renderLite(<ModelPicker value={null} onPick={() => undefined} onConnect={onConnect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Model: No model chosen' }));
    expect(screen.getByText('No models yet')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Connect a service' }));
    expect(onConnect).toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says which service could not be read, and why; and a long list is cut with a search hint', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      model({ modelId: `m${i}`, displayName: `Model ${i}` }),
    );
    useConnectionsStore.setState({
      models: many,
      problems: [
        {
          connectionId: 'c3',
          connectionName: 'Mistral',
          code: 'PROVIDER_AUTH_FAILED',
          message: 'bad key',
        },
      ],
    });
    renderLite(<ModelPicker value={null} onPick={() => undefined} onConnect={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    expect(screen.getAllByRole('option')).toHaveLength(80);
    expect(screen.getByText(/80 \/ 120/)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Mistral: bad key');
  });

  it('refreshes the list when asked', async () => {
    const invoke = bridge({ 'models:list': () => ({ models: two, problems: [] }) });
    useConnectionsStore.setState({ models: [] });
    renderLite(<ModelPicker value={null} onPick={() => undefined} onConnect={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Look again' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('models:list', { refresh: true }));
    await waitFor(() => expect(useConnectionsStore.getState().models).toHaveLength(3));
  });
});

describe('a reply on the screen', () => {
  it('shows what a model writes as formatted text, and never runs a link that is not plain web', () => {
    renderLite(
      <AssistantMessage
        message={message({
          content:
            'Hello **bold** and `code` and [fine](https://example.com) and [bad](javascript:alert(1)).',
        })}
      />,
    );
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: 'fine' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('says in plain words why a reply failed, by what went wrong', () => {
    const { unmount } = renderLite(
      <AssistantMessage
        message={message({
          status: 'error',
          error: { code: 'PROVIDER_AUTH_FAILED', message: 'raw' },
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The service did not accept the key. Check it in Settings.',
    );
    unmount();
    renderLite(
      <AssistantMessage
        message={message({ status: 'error', error: { code: 'WEIRD', message: 'raw detail' } })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('raw detail');
  });

  it('in Bengali the explanation is in Bengali', () => {
    renderLite(
      <AssistantMessage
        message={message({ status: 'error', error: { code: 'TIMEOUT', message: 'x' } })}
      />,
      'bn',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('সেবাটি উত্তর দিতে বেশি সময় নিয়েছে।');
  });

  it('shows a stopped reply with what was written, a waiting reply with dots, and the steps taken', () => {
    const { unmount } = renderLite(
      <AssistantMessage message={message({ status: 'cancelled', content: 'Half an ans' })} />,
    );
    expect(screen.getByText('Half an ans')).toBeVisible();
    expect(screen.getByText('Stopped')).toBeVisible();
    unmount();
    const waiting = renderLite(<AssistantMessage message={message({ status: 'streaming' })} />);
    expect(screen.getByRole('status')).toBeVisible();
    waiting.unmount();
    renderLite(
      <AssistantMessage
        message={message({
          content: 'Done.',
          steps: [
            {
              id: 's1',
              tool: 'read_page',
              summary: 'Read page: example.com',
              status: 'done',
              output: 'Example Domain',
            },
            {
              id: 's2',
              tool: 'post',
              summary: 'Post: hi',
              status: 'denied',
              output: 'The user did not allow this',
            },
            { id: 's3', tool: 'x', summary: 'Working', status: 'running' },
          ],
        })}
      />,
    );
    expect(screen.getByText('Read page: example.com')).toBeVisible();
    expect(screen.getByText('Example Domain')).toBeInTheDocument();
    expect(screen.getByText(/not allowed/)).toBeVisible();
    expect(screen.getByText(/working/)).toBeVisible();
  });

  it('can be copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderLite(<AssistantMessage message={message({ content: 'Copy me' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Copy me');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });
});

describe('the chat screen', () => {
  it('asks to connect a service when none is, and takes the person to the settings', async () => {
    useConnectionsStore.setState({ connections: [], loaded: true });
    renderLite(<ChatView onFailure={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Connect an AI service to begin' })).toBeVisible();
    await userEvent.click(screen.getAllByRole('button', { name: 'Connect a service' })[0]!);
    expect(useAppStore.getState()).toMatchObject({ route: 'settings', settingsTab: 'providers' });
  });

  it('greets by name when it knows it, and falls back to the first model offered', async () => {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, userName: 'Babul' } });
    useConnectionsStore.setState({
      connections: [
        {
          id: 'c1',
          kind: 'anthropic',
          name: 'A',
          hasKey: true,
          keyOptional: false,
          manualModels: [],
        },
      ],
      models: [model()],
    });
    renderLite(<ChatView onFailure={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Hello, Babul' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Model: Claude Sonnet' })).toBeVisible();
  });

  it('shows the conversation and turns Send into Stop while the last reply is streaming', () => {
    useConnectionsStore.setState({
      connections: [
        {
          id: 'c1',
          kind: 'anthropic',
          name: 'A',
          hasKey: true,
          keyOptional: false,
          manualModels: [],
        },
      ],
      models: [model()],
    });
    useChatStore.setState({
      activeId: 'chat1',
      messages: [
        message({ id: 'u', role: 'user', content: 'Hi' }),
        message({ id: 'r', status: 'streaming', content: 'Hel' }),
      ],
    });
    renderLite(<ChatView onFailure={() => undefined} />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(within(log).getByText('Hi')).toBeVisible();
    expect(within(log).getByText('Hel')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
  });

  it('explains a failed send in words, and keeps the text', async () => {
    useConnectionsStore.setState({
      connections: [
        {
          id: 'c1',
          kind: 'anthropic',
          name: 'A',
          hasKey: true,
          keyOptional: false,
          manualModels: [],
        },
      ],
      models: [model()],
    });
    bridge({
      'chat:send': () => {
        throw Object.assign(new Error('x'), { code: 'PROVIDER_RATE_LIMITED' });
      },
    });
    const onFailure = vi.fn();
    renderLite(<ChatView onFailure={onFailure} />);
    const box = screen.getByRole('textbox', { name: 'Message Allaya…' });
    await userEvent.type(box, 'hello{Enter}');
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('busy')));
    await waitFor(() => expect(box).toHaveValue('hello'));
  });
});

describe('the list of chats', () => {
  const chats = [
    { id: 'a', title: 'Plan my week', model: null, createdAt: 2, updatedAt: 2 },
    { id: 'b', title: 'বাংলা প্রশ্ন', model: null, createdAt: 1, updatedAt: 1 },
  ];

  it('lists chats, opens one, starts a new one, and goes to the settings', async () => {
    const invoke = bridge({ 'chats:get': () => ({ chat: chats[0], messages: [] }) });
    useChatStore.setState({ chats, activeId: 'a' });
    renderLite(<Sidebar />);
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(
      within(nav)
        .getAllByRole('button')
        .filter((b) => b.textContent),
    ).toHaveLength(2);
    expect(within(nav).getByRole('button', { name: 'Plan my week' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.click(within(nav).getByRole('button', { name: 'বাংলা প্রশ্ন' }));
    expect(invoke).toHaveBeenCalledWith('chats:get', { id: 'b' });
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(useChatStore.getState().activeId).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useAppStore.getState().route).toBe('settings');
  });

  it('says there are none yet, and deletes a chat on request', async () => {
    const empty = renderLite(<Sidebar />);
    expect(screen.getByText('No chats yet')).toBeVisible();
    empty.unmount();
    const invoke = bridge({ 'chats:list': () => [] });
    useChatStore.setState({ chats: [chats[0]!], activeId: null });
    renderLite(<Sidebar />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete chat “Plan my week”' }));
    expect(invoke).toHaveBeenCalledWith('chats:remove', { id: 'a' });
  });

  it('is in Bengali when the screen is, with the name আলেয়া', () => {
    renderLite(<Sidebar />, 'bn');
    expect(screen.getByText('আলেয়া')).toBeVisible();
    expect(screen.getByRole('button', { name: 'নতুন চ্যাট' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'সেটিংস' })).toBeVisible();
  });
});
