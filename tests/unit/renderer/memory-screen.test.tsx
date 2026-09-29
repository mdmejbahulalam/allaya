import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryOverview, MemoryView } from '@allaya/validation';
import { MemoryScreen } from '../../../apps/desktop/renderer/src/features/memory/memory-screen';
import { useMemoryStore } from '@renderer/stores/memory';
import { useToastStore } from '@renderer/stores/toasts';
import { renderUi } from '../../helpers/render';

const NOW = new Date(2026, 4, 4, 8, 0).getTime();

const memory = (over: Partial<MemoryView> = {}): MemoryView => ({
  id: 'mem_1',
  category: 'preferences',
  key: 'preferred browser',
  value: 'Edge',
  source: 'user',
  origin: 'screen',
  useCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

let invoke: ReturnType<typeof vi.fn>;

function bridge(
  overview: MemoryOverview = { memories: [], enabled: true, limit: 500 },
  handlers: Record<string, (p: never) => unknown> = {},
) {
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const custom = handlers[channel];
    if (custom) {
      const value = await custom(payload as never);
      if (value && typeof value === 'object' && '__error' in value) {
        return { ok: false, error: value.__error };
      }
      return { ok: true, data: value };
    }
    switch (channel) {
      case 'memory:list':
        return { ok: true, data: overview };
      case 'memory:export':
        return { ok: true, data: { saved: true } };
      case 'memory:create':
      case 'memory:update':
        return { ok: true, data: memory() };
      default:
        return { ok: true, data: { ok: true } };
    }
  });
  (window as unknown as { allaya: unknown }).allaya = {
    invoke,
    subscribe: () => () => undefined,
  };
}
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel);
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);
const items = () => screen.queryAllByTestId('memory-item');

beforeEach(() => {
  bridge();
  useMemoryStore.setState({ overview: null });
});

describe('the Memory screen', () => {
  it('starts with a plain empty state, the privacy promise, and a way to add one', async () => {
    renderUi(<MemoryScreen />);
    expect(await screen.findByText('Nothing remembered yet.')).toBeInTheDocument();
    expect(screen.getByText(/Memories are stored only on this computer/)).toBeInTheDocument();
    expect(screen.getByText(/never keeps passwords, keys or card numbers/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add a memory' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Forget everything' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save a copy…' })).toBeDisabled();
  });

  it('shows each memory with who added it and how often it was used', async () => {
    bridge({
      memories: [
        memory(),
        memory({
          id: 'mem_2',
          category: 'facts',
          key: 'favourite music',
          value: 'old Bengali songs',
          source: 'inferred',
          origin: 'chat',
          useCount: 3,
          lastUsedAt: NOW,
        }),
        memory({
          id: 'mem_3',
          category: 'personal',
          key: 'মায়ের নাম',
          value: 'ফাতেমা',
          useCount: 1,
        }),
      ],
      enabled: true,
      limit: 500,
    });
    renderUi(<MemoryScreen />);
    await screen.findAllByTestId('memory-item');
    const rows = items();
    expect(rows).toHaveLength(3);
    expect(
      within(rows[0]!).getByRole('heading', { name: 'preferred browser' }),
    ).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Added by you')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Not used yet')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Suggested by Allaya, approved by you')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Used 3 times')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Last used/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Used once')).toBeInTheDocument();
    expect(screen.getByText('3 of 500 kept')).toBeInTheDocument();
  });

  it('filters by category and by words, Bengali included', async () => {
    bridge({
      memories: [
        memory(),
        memory({ id: 'mem_2', category: 'facts', key: 'music', value: 'old songs' }),
        memory({ id: 'mem_3', category: 'personal', key: 'মায়ের নাম', value: 'ফাতেমা' }),
      ],
      enabled: true,
      limit: 500,
    });
    renderUi(<MemoryScreen />);
    await screen.findAllByTestId('memory-item');
    await userEvent.click(screen.getByRole('button', { name: /^Facts/ }));
    expect(items()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /^All$/ }));
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search what Allaya remembers' }),
      'ফাতেমা',
    );
    expect(items()).toHaveLength(1);
    expect(screen.getByText('মায়ের নাম')).toBeInTheDocument();
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'EDGE');
    expect(items()).toHaveLength(1);
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'nothing like this');
    expect(screen.getByText('No memories match.')).toBeInTheDocument();
  });

  it('adds one: asks for what is missing, then sends it tidied', async () => {
    renderUi(<MemoryScreen />);
    await screen.findByText('Nothing remembered yet.');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add a memory' })[0]!);
    const form = await screen.findByRole('dialog', { name: 'Add a memory' });
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByText('Give it a title.')).toBeInTheDocument();
    expect(within(form).getByText('Say what to remember.')).toBeInTheDocument();
    expect(calls('memory:create')).toEqual([]);

    await userEvent.selectOptions(within(form).getByLabelText('Category'), 'applications');
    await userEvent.type(within(form).getByLabelText('Title'), '  Editor  ');
    await userEvent.type(within(form).getByLabelText('What should Allaya remember?'), ' VS Code ');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls('memory:create')).toEqual([
        ['memory:create', { category: 'applications', key: 'Editor', value: 'VS Code' }],
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a memory' })).toBeNull());
  });

  it('explains a refusal from the backend — a secret, a duplicate — and keeps the form open', async () => {
    bridge(undefined, {
      'memory:create': () => ({
        __error: {
          code: 'INVALID_INPUT',
          message: 'nope',
          details: { reason: 'looks_secret' },
        },
      }),
    });
    renderUi(<MemoryScreen />);
    await screen.findByText('Nothing remembered yet.');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add a memory' })[0]!);
    const form = await screen.findByRole('dialog', { name: 'Add a memory' });
    await userEvent.type(within(form).getByLabelText('Title'), 'wifi');
    await userEvent.type(
      within(form).getByLabelText('What should Allaya remember?'),
      'password is x1',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(form).findByText(/looks like a password, key or card number/),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add a memory' })).toBeInTheDocument();
  });

  it('explains a duplicate title next to the title', async () => {
    bridge(undefined, {
      'memory:create': () => ({
        __error: { code: 'INVALID_INPUT', message: 'dup', details: { reason: 'duplicate' } },
      }),
    });
    renderUi(<MemoryScreen />);
    await screen.findByText('Nothing remembered yet.');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add a memory' })[0]!);
    const form = await screen.findByRole('dialog', { name: 'Add a memory' });
    await userEvent.type(within(form).getByLabelText('Title'), 'a');
    await userEvent.type(within(form).getByLabelText('What should Allaya remember?'), 'b');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/already have one with that title/)).toBeInTheDocument();
  });

  it("warns that standing instructions are the person's alone", async () => {
    renderUi(<MemoryScreen />);
    await screen.findByText('Nothing remembered yet.');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add a memory' })[0]!);
    const form = await screen.findByRole('dialog', { name: 'Add a memory' });
    expect(within(form).queryByText(/Only you can add these/)).toBeNull();
    await userEvent.selectOptions(within(form).getByLabelText('Category'), 'instructions');
    expect(within(form).getByText(/Only you can add these/)).toBeInTheDocument();
  });

  it('edits one: the form starts with what is there, and saves by id', async () => {
    bridge({ memories: [memory({ source: 'inferred' })], enabled: true, limit: 500 });
    renderUi(<MemoryScreen />);
    await screen.findByTestId('memory-item');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('dialog', { name: 'Edit memory' });
    expect(within(form).getByLabelText('Title')).toHaveValue('preferred browser');
    expect(within(form).getByLabelText('What should Allaya remember?')).toHaveValue('Edge');
    await userEvent.clear(within(form).getByLabelText('What should Allaya remember?'));
    await userEvent.type(within(form).getByLabelText('What should Allaya remember?'), 'Firefox');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls('memory:update')).toEqual([
        [
          'memory:update',
          {
            id: 'mem_1',
            changes: { category: 'preferences', key: 'preferred browser', value: 'Firefox' },
          },
        ],
      ]),
    );
  });

  it('forgets one only after asking; cancelling forgets nothing', async () => {
    bridge({ memories: [memory()], enabled: true, limit: 500 });
    renderUi(<MemoryScreen />);
    await screen.findByTestId('memory-item');
    await userEvent.click(screen.getByRole('button', { name: 'Forget this' }));
    expect(await screen.findByText('“preferred browser” will be forgotten.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls('memory:delete')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Forget this' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget this' }));
    await waitFor(() =>
      expect(calls('memory:delete')).toEqual([['memory:delete', { id: 'mem_1' }]]),
    );
    await waitFor(() => expect(toasts()).toContain('Forgot “preferred browser”'));
  });

  it('forgets everything only after asking, saying how many', async () => {
    bridge({
      memories: [memory(), memory({ id: 'mem_2', key: 'b' })],
      enabled: true,
      limit: 500,
    });
    renderUi(<MemoryScreen />);
    await screen.findAllByTestId('memory-item');
    await userEvent.click(screen.getByRole('button', { name: 'Forget everything' }));
    expect(await screen.findByText(/All 2 memories will be deleted/)).toBeInTheDocument();
    expect(calls('memory:deleteAll')).toEqual([]);
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget everything' }));
    await waitFor(() => expect(calls('memory:deleteAll')).toHaveLength(1));
  });

  it('the switch turns memory off, and says plainly what off means', async () => {
    renderUi(<MemoryScreen />);
    await screen.findByText('Nothing remembered yet.');
    await userEvent.click(screen.getByRole('switch', { name: 'Let Allaya use and save memories' }));
    await waitFor(() =>
      expect(calls('memory:setEnabled')).toEqual([['memory:setEnabled', { enabled: false }]]),
    );
  });

  it('when memory is off, a notice says nothing is used or saved and what is here stays', async () => {
    bridge({ memories: [memory()], enabled: false, limit: 500 });
    renderUi(<MemoryScreen />);
    expect(await screen.findByText('Memory is off')).toBeInTheDocument();
    expect(screen.getByText(/stays until you delete it/)).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Let Allaya use and save memories' }),
    ).not.toBeChecked();
    // The person can still look at, change and remove what is there.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('saves a copy through the system dialog, says so, stays quiet if cancelled, and reports a failure', async () => {
    let saved = true;
    bridge(
      { memories: [memory()], enabled: true, limit: 500 },
      { 'memory:export': () => ({ saved }) },
    );
    renderUi(<MemoryScreen />);
    await screen.findByTestId('memory-item');
    await userEvent.click(screen.getByRole('button', { name: 'Save a copy…' }));
    await waitFor(() => expect(toasts()).toContain('Saved 1 memories'));
    saved = false;
    useToastStore.setState({ toasts: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Save a copy…' }));
    await waitFor(() => expect(calls('memory:export')).toHaveLength(2));
    expect(toasts()).toEqual([]);
  });

  it('says so when the copy could not be saved', async () => {
    bridge(
      { memories: [memory()], enabled: true, limit: 500 },
      { 'memory:export': () => ({ __error: { code: 'INTERNAL', message: 'x' } }) },
    );
    renderUi(<MemoryScreen />);
    await screen.findByTestId('memory-item');
    await userEvent.click(screen.getByRole('button', { name: 'Save a copy…' }));
    await waitFor(() => expect(toasts()).toContain('Could not save the file'));
  });

  it('will not offer another when the memory is full', async () => {
    const many = Array.from({ length: 3 }, (_, i) => memory({ id: `m${i}`, key: `k${i}` }));
    bridge({ memories: many, enabled: true, limit: 3 });
    renderUi(<MemoryScreen />);
    await screen.findAllByTestId('memory-item');
    expect(screen.getByRole('button', { name: 'Add a memory' })).toBeDisabled();
  });

  it('is in Bengali when the app is', async () => {
    bridge({ memories: [memory({ source: 'inferred', useCount: 2 })], enabled: true, limit: 500 });
    renderUi(<MemoryScreen />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByRole('heading', { name: 'মেমরি', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Allaya প্রস্তাব করেছে, আপনি অনুমোদন করেছেন')).toBeInTheDocument();
    expect(screen.getByText(/বার ব্যবহার হয়েছে/)).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Allaya স্মৃতি ব্যবহার ও সংরক্ষণ করুক' }),
    ).toBeInTheDocument();
  });

  it('shows a plain message when it cannot load', async () => {
    invoke = vi.fn(async () => ({ ok: false, error: { code: 'INTERNAL', message: 'x' } }));
    (window as unknown as { allaya: unknown }).allaya = {
      invoke,
      subscribe: () => () => undefined,
    };
    renderUi(<MemoryScreen />);
    expect(await screen.findByText('Something went wrong.')).toBeInTheDocument();
  });
});
