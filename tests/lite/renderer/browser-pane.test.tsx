import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '@lite/shared/ipc';
import { BrowserPane } from '@lite/renderer/src/components/browser-pane';
import { ChatView } from '@lite/renderer/src/components/chat-view';
import { useBrowserStore } from '@lite/renderer/src/stores/browser';
import { useConnectionsStore } from '@lite/renderer/src/stores/connections';
import { bridge, fail, model, renderLite, resetStores } from './helpers';

const tab = (over: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 't1',
  url: 'https://example.com/page',
  title: 'Example Domain',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...over,
});
const withTabs = (tabs: BrowserTab[], activeId: string | null = tabs[0]?.id ?? null) =>
  useBrowserStore.setState({ state: { tabs, activeId }, open: true, width: 520 });

beforeEach(() => {
  resetStores();
  useBrowserStore.setState({
    state: { tabs: [], activeId: null },
    open: true,
    width: 520,
    refused: null,
  });
  Element.prototype.getBoundingClientRect = () => ({
    left: 300,
    top: 88,
    width: 520,
    height: 600,
    right: 820,
    bottom: 688,
    x: 300,
    y: 88,
    toJSON: () => ({}),
  });
});

const setup = (props: Partial<Parameters<typeof BrowserPane>[0]> = {}) =>
  renderLite(<BrowserPane onAsk={() => undefined} onNotice={() => undefined} {...props} />);
const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([c]) => c === channel);

describe('the browser pane', () => {
  it('invites the person to browse, and says what Allaya does and does not do with pages', () => {
    bridge();
    setup();
    expect(screen.getByText('Browse with Allaya')).toBeVisible();
    expect(screen.getByText(/it never clicks, types or submits on a page/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask about this page' })).toBeDisabled();
  });

  it('goes where the person types, and clears the box after', async () => {
    const invoke = bridge();
    setup();
    const box = screen.getByRole('textbox', { name: 'Search or enter an address' });
    await userEvent.type(box, 'weather in dhaka{Enter}');
    expect(invoke).toHaveBeenCalledWith('browser:go', { input: 'weather in dhaka' });
    expect(box).toHaveValue('');
  });

  it('does not go anywhere for an empty box', async () => {
    const invoke = bridge();
    setup();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search or enter an address' }),
      '   {Enter}',
    );
    expect(calls(invoke, 'browser:go')).toHaveLength(0);
  });

  it('says so when what was typed is not something it can open', async () => {
    bridge({
      'browser:go': () => {
        throw fail('INVALID_INPUT', 'no', { reason: 'not_an_address' });
      },
    });
    const onNotice = vi.fn();
    setup({ onNotice });
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search or enter an address' }),
      'javascript:1{Enter}',
    );
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith('That is not an address or something to search for.'),
    );
  });

  it('shows the tabs and the address of the page, and switches and closes tabs', async () => {
    const invoke = bridge();
    withTabs([tab(), tab({ id: 't2', url: 'https://www.news.example/', title: '' })], 't1');
    setup();
    expect(screen.getByRole('textbox', { name: 'Search or enter an address' })).toHaveValue(
      'https://example.com/page',
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Example Domain', 'news.example']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(tabs[1]!);
    expect(invoke).toHaveBeenCalledWith('browser:activate', { id: 't2' });
    await userEvent.click(screen.getByRole('button', { name: 'Close tab “news.example”' }));
    expect(invoke).toHaveBeenCalledWith('browser:close', { id: 't2' });
    await userEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(invoke).toHaveBeenCalledWith('browser:newTab', {});
  });

  it('enables back and forward only when there is somewhere to go, and reload becomes stop while loading', async () => {
    const invoke = bridge();
    withTabs([tab({ canGoBack: true, canGoForward: false })]);
    const { unmount } = setup();
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(invoke).toHaveBeenCalledWith('browser:back', {});
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(invoke).toHaveBeenCalledWith('browser:reload', {});
    unmount();
    withTabs([tab({ loading: true })]);
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Stop loading' }));
    expect(invoke).toHaveBeenCalledWith('browser:stop', {});
  });

  it('offers to ask about the page that is open, and to close the browser', async () => {
    bridge();
    withTabs([tab()]);
    const onAsk = vi.fn();
    setup({ onAsk });
    await userEvent.click(screen.getByRole('button', { name: 'Ask about this page' }));
    expect(onAsk).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Close the browser' }));
    expect(useBrowserStore.getState().open).toBe(false);
  });

  it('tells the engine where the page goes, and hides it when the pane goes away', async () => {
    const invoke = bridge();
    withTabs([tab()]);
    const { unmount } = setup();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('browser:bounds', {
        x: 300,
        y: 88,
        width: 520,
        height: 600,
        visible: true,
      }),
    );
    unmount();
    expect(invoke).toHaveBeenLastCalledWith(
      'browser:bounds',
      expect.objectContaining({ visible: false }),
    );
  });

  it('can be made wider or narrower by dragging its edge, within limits', () => {
    bridge();
    setup();
    const edge = screen.getByRole('separator', { name: 'Resize the browser' });
    fireEvent.pointerDown(edge, { clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 700, pointerId: 1 });
    expect(useBrowserStore.getState().width).toBe(620);
    fireEvent.pointerMove(edge, { clientX: 3000, pointerId: 1 });
    expect(useBrowserStore.getState().width).toBe(320);
    fireEvent.pointerUp(edge, { pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 100, pointerId: 1 });
    expect(useBrowserStore.getState().width).toBe(320);
  });

  it('is in Bengali when the screen is', () => {
    bridge();
    renderLite(<BrowserPane onAsk={() => undefined} onNotice={() => undefined} />, 'bn');
    expect(screen.getByText('আলেয়ার সঙ্গে ব্রাউজ করুন')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'খুঁজুন বা ঠিকানা লিখুন' })).toBeVisible();
  });
});

describe('opening the browser from the chat', () => {
  const ready = () => {
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
  };

  it('is shown beside the chat when switched on, and hidden when switched off', async () => {
    bridge();
    ready();
    useBrowserStore.setState({ open: false });
    renderLite(<ChatView onFailure={() => undefined} />);
    const toggle = screen.getByRole('button', { name: 'Browser' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('complementary', { name: 'Browser' })).toBeNull();
    await userEvent.click(toggle);
    expect(await screen.findByRole('complementary', { name: 'Browser' })).toBeVisible();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(toggle);
    expect(screen.queryByRole('complementary', { name: 'Browser' })).toBeNull();
  });

  it('"ask about this page" sends the question to the chat', async () => {
    const invoke = bridge({
      'chat:send': () => ({
        chat: { id: 'c', title: 't', model: null, createdAt: 1, updatedAt: 1 },
        userMessage: {
          id: 'u',
          chatId: 'c',
          role: 'user',
          content: 'x',
          status: 'complete',
          createdAt: 1,
        },
        reply: {
          id: 'r',
          chatId: 'c',
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: 1,
        },
      }),
    });
    ready();
    withTabs([tab()]);
    renderLite(<ChatView onFailure={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask about this page' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('chat:send', {
        text: 'Read the page I have open in the browser and summarize it.',
      }),
    );
  });
});

describe('a file a page offered', () => {
  it('says it was not saved, and can be dismissed', async () => {
    bridge();
    useBrowserStore.setState({ refused: 'report.pdf' });
    renderLite(<BrowserPane onAsk={() => undefined} onNotice={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Downloads are not supported yet: “report.pdf” was not saved.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useBrowserStore.getState().refused).toBeNull();
  });
});
