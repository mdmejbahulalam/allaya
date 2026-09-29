import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileListing, FileOutcome, FilesOverview, FileSearchResult } from '@allaya/validation';
import { FilesScreen } from '../../../apps/desktop/renderer/src/features/files/files-screen';
import { useToastStore } from '@renderer/stores/toasts';
import { renderUi } from '../../helpers/render';

const overview = (over: Partial<FilesOverview> = {}): FilesOverview => ({
  roots: [
    {
      id: 'desktop',
      label: 'Desktop',
      location: 'C:\\Users\\me\\Desktop',
      origin: 'known',
      exists: true,
    },
    {
      id: 'documents',
      label: 'Documents',
      location: 'C:\\Users\\me\\Documents',
      origin: 'known',
      exists: true,
    },
    { id: 'user-1', label: 'Projects', location: 'D:\\Projects', origin: 'user', exists: true },
    {
      id: 'music',
      label: 'Music',
      location: 'C:\\Users\\me\\Music',
      origin: 'known',
      exists: false,
    },
  ],
  recent: [{ label: 'report.docx', path: 'Documents/report.docx' }],
  actions: [],
  deletesAreRestorable: false,
  accessOff: false,
  ...over,
});

const entry = (name: string, kind: 'file' | 'directory' = 'file', size = 2048) => ({
  name,
  kind,
  size,
  modifiedAt: Date.UTC(2026, 8, 1, 10, 30),
  hidden: false,
});

const listings: Record<string, FileListing> = {
  Desktop: { path: 'Desktop', entries: [], total: 0, truncated: false, omitted: 0 },
  Documents: {
    path: 'Documents',
    entries: [
      entry('Reports', 'directory', 0),
      entry('notes.txt'),
      entry('big.iso', 'file', 3 * 1024 ** 3),
    ],
    total: 3,
    truncated: false,
    omitted: 2,
  },
  'Documents/Reports': {
    path: 'Documents/Reports',
    entries: [entry('q1.txt')],
    total: 1,
    truncated: false,
    omitted: 0,
  },
};

let invoke: ReturnType<typeof vi.fn>;
let listeners: Array<(payload: unknown) => void>;

function bridge(
  handlers: Record<string, (payload: never) => unknown> = {},
  state: { overview?: FilesOverview } = {},
) {
  listeners = [];
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const custom = handlers[channel];
    if (custom) {
      const value = await custom(payload as never);
      if (value && typeof value === 'object' && '__error' in value) {
        return { ok: false, error: value.__error };
      }
      return { ok: true, data: value };
    }
    if (channel === 'files:overview') return { ok: true, data: state.overview ?? overview() };
    if (channel === 'files:list') {
      const path = (payload as { path: string }).path;
      const listing = listings[path];
      return listing
        ? { ok: true, data: listing }
        : { ok: false, error: { code: 'NOT_FOUND', message: 'x', retryable: false } };
    }
    return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: channel, retryable: false } };
  });
  (window as unknown as { allaya: unknown }).allaya = {
    invoke,
    subscribe: (_channel: string, listener: (payload: unknown) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
  };
}

const outcome = (over: Partial<FileOutcome> = {}): FileOutcome => ({
  ok: true,
  status: 'success',
  summary: 'Do the thing',
  ...over,
});

beforeEach(() => bridge());

describe('Files screen', () => {
  it('lists a folder with folders first, sizes, and a note about hidden secrets', async () => {
    renderUi(<FilesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    const table = await screen.findByRole('table', { name: 'Files' });
    expect(await within(table).findByText('Reports')).toBeInTheDocument();
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');
    expect(names[0]).toContain('Reports'); // the folder comes first
    expect(within(table).getByText('notes.txt')).toBeInTheDocument();
    expect(within(table).getByText('3 GB')).toBeInTheDocument();
    expect(
      screen.getByText('3 items · 2 items are hidden because they usually hold passwords or keys.'),
    ).toBeInTheDocument();
  });

  it('opens in the first folder that exists, and says so when it is empty', async () => {
    renderUi(<FilesScreen />);
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Desktop', current: 'location' }),
    ).toBeInTheDocument();
  });

  it('lists the folders in the sidebar, marks one that no longer exists, and lets the user drop their own', async () => {
    bridge({ 'files:removeFolder': () => ({ ok: true }) });
    renderUi(<FilesScreen />);
    const missing = await screen.findByRole('button', { name: /Music/ });
    expect(missing).toBeDisabled();
    expect(missing).toHaveAttribute('title', 'This folder no longer exists on this computer.');
    await userEvent.click(screen.getByRole('button', { name: 'Stop using Projects' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:removeFolder', { id: 'user-1' }),
    );
    // Only folders the user added get the button — the system's own folders cannot be removed here.
    expect(screen.queryByRole('button', { name: 'Stop using Documents' })).toBeNull();
  });

  it('navigates into a folder and back up through the breadcrumb', async () => {
    renderUi(<FilesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reports' }));
    expect(await screen.findByText('q1.txt')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('files:list', {
      path: 'Documents/Reports',
      showHidden: false,
    });
    const trail = screen.getByRole('navigation', { name: 'Folder path' });
    expect(within(trail).getByRole('button', { name: 'Reports' })).toHaveAttribute(
      'aria-current',
      'location',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Up one folder' }));
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
  });

  it('ignores a slow answer for a folder the user already left', async () => {
    let releaseSlow: (value: FileListing) => void = () => undefined;
    bridge({
      'files:list': ({ path }: { path: string }) =>
        path === 'Documents'
          ? new Promise<FileListing>((resolve) => (releaseSlow = resolve))
          : listings[path],
    });
    renderUi(<FilesScreen />);
    await screen.findByText('This folder is empty.'); // Desktop
    await userEvent.click(screen.getByRole('button', { name: 'Documents' }));
    await userEvent.click(screen.getByRole('button', { name: 'Desktop' }));
    releaseSlow(listings['Documents']!);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('notes.txt')).toBeNull();
    expect(screen.getByText('This folder is empty.')).toBeInTheDocument();
  });

  it('explains a refusal in words, from the reason — not a raw error', async () => {
    bridge({
      'files:list': () => ({
        __error: {
          code: 'PATH_NOT_ALLOWED',
          message: 'raw english',
          retryable: false,
          details: { reason: 'secret' },
        },
      }),
    });
    renderUi(<FilesScreen />);
    expect(await screen.findByText('Could not load this folder.')).toBeInTheDocument();
    expect(
      screen.getByText('Allaya does not open files that usually hold passwords or keys.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('raw english')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('searches as you type, and says when a search was cut short', async () => {
    const result: FileSearchResult = {
      hits: [
        { path: 'Documents/Reports/q1.txt', name: 'q1.txt', kind: 'file', size: 10, modifiedAt: 1 },
        { path: 'Desktop/q1-old', name: 'q1-old', kind: 'directory', size: 0, modifiedAt: 1 },
      ],
      scanned: 20_000,
      truncated: true,
    };
    bridge({ 'files:search': () => result });
    renderUi(<FilesScreen />);
    await screen.findByText('This folder is empty.');
    await userEvent.type(screen.getByRole('searchbox'), 'q1');
    expect(await screen.findByText('q1-old')).toBeInTheDocument();
    expect(screen.getByText('Results for “q1”')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('cut short');
    // Search looks in every folder, not just the one that happens to be open.
    expect(invoke).toHaveBeenCalledWith('files:search', { query: 'q1' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    bridge({ 'files:search': () => ({ hits: [], scanned: 5, truncated: false }) });
    renderUi(<FilesScreen />);
    await screen.findByText('This folder is empty.');
    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    expect(await screen.findByText('Nothing found.')).toBeInTheDocument();
  });

  it('creates a folder through the pipeline and confirms with a localized sentence', async () => {
    bridge({ 'files:createFolder': () => outcome({ summary: 'Create the folder “Desktop/New”' }) });
    renderUi(<FilesScreen />);
    await screen.findByText('This folder is empty.');
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Folder name'), 'New');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:createFolder', { path: 'Desktop/New' }),
    );
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'Done: Create the folder “Desktop/New”',
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('will not submit a name with a slash — a name is a name, not a path', async () => {
    renderUi(<FilesScreen />);
    await screen.findByText('This folder is empty.');
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Folder name'), '../evil');
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('renames with the current name filled in', async () => {
    bridge({ 'files:rename': () => outcome() });
    renderUi(<FilesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Rename: notes.txt' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('New name');
    expect(input).toHaveValue('notes.txt');
    await userEvent.clear(input);
    await userEvent.type(input, 'todo.txt');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:rename', {
        path: 'Documents/notes.txt',
        newName: 'todo.txt',
      }),
    );
  });

  it('deleting goes straight to the pipeline (which asks); a "no" changes nothing and says so', async () => {
    bridge({ 'files:delete': () => outcome({ ok: false, status: 'rejected' }) });
    renderUi(<FilesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move to trash: Reports' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:delete', {
        path: 'Documents/Reports',
        folder: true,
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Move to trash: notes.txt' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:delete', {
        path: 'Documents/notes.txt',
        folder: false,
      }),
    );
    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => t.message === 'You said no. Nothing changed.'),
      ).toBe(true),
    );
  });

  it("shows a refusal reason from a failed change in the user's language", async () => {
    bridge({ 'files:rename': () => outcome({ ok: false, status: 'failed', reason: 'exists' }) });
    renderUi(<FilesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Rename: notes.txt' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rename' }),
    );
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'Something with that name already exists. Nothing was overwritten.',
      ),
    );
  });

  it('offers to open files but not folders, and reports the request truthfully', async () => {
    bridge({ 'files:open': () => ({ ok: true }) });
    renderUi(<FilesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    expect(screen.queryByRole('button', { name: 'Open: Reports' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Open: notes.txt' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:open', { path: 'Documents/notes.txt' }),
    );
    // "Asked Windows to open", never "opened": the app may not have started.
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'Asked Windows to open “notes.txt”.',
      ),
    );
  });

  it('shows an item in Explorer, for files and folders alike', async () => {
    bridge({ 'files:reveal': () => ({ ok: true }) });
    renderUi(<FilesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Documents' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Show in Explorer: Reports' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:reveal', { path: 'Documents/Reports' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show in Explorer: notes.txt' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:reveal', { path: 'Documents/notes.txt' }),
    );
  });

  it('adds a folder through the system picker and moves into it', async () => {
    bridge({
      'files:addFolder': () => ({
        added: {
          id: 'user-2',
          label: 'Photos',
          location: 'E:\\Photos',
          origin: 'user',
          exists: true,
        },
      }),
    });
    renderUi(<FilesScreen />);
    await screen.findByText('This folder is empty.');
    await userEvent.click(screen.getByRole('button', { name: 'Add a folder' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('files:list', { path: 'Photos', showHidden: false }),
    );
    expect(useToastStore.getState().toasts.some((t) => t.message === 'Added “Photos”.')).toBe(true);
  });

  it('shows what Allaya changed, and lets a still-safe change be undone', async () => {
    const now = Date.UTC(2026, 8, 2, 9, 0);
    bridge(
      { 'files:undo': () => outcome() },
      {
        overview: overview({
          actions: [
            {
              id: 'a1',
              kind: 'move',
              label: 'Documents/a.txt',
              target: 'Desktop/a.txt',
              undoable: true,
              undone: false,
              createdAt: now,
            },
            {
              id: 'a2',
              kind: 'trash',
              label: 'Documents/old.txt',
              undoable: false,
              undone: false,
              createdAt: now,
              note: 'It is in the Recycle Bin; restore it from there.',
            },
            {
              id: 'a3',
              kind: 'create_file',
              label: 'Documents/new.txt',
              undoable: true,
              undone: true,
              createdAt: now,
            },
          ],
        }),
      },
    );
    renderUi(<FilesScreen />);
    expect(await screen.findByText('Moved a.txt to Desktop/a.txt')).toBeInTheDocument();
    expect(screen.getByText('Moved old.txt to the trash')).toBeInTheDocument();
    expect(screen.getByText(/restore it from there/)).toBeInTheDocument();
    expect(screen.getByText('Undone')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('files:undo', { actionId: 'a1' }));
  });

  it('reloads when the backend says something changed', async () => {
    renderUi(<FilesScreen />);
    await screen.findByText('This folder is empty.');
    const before = invoke.mock.calls.filter(([c]) => c === 'files:list').length;
    listeners.forEach((l) => l({}));
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === 'files:list').length).toBeGreaterThan(before),
    );
  });

  it('when file access is off it says so instead of showing an empty list', async () => {
    bridge({}, { overview: overview({ accessOff: true, roots: [] }) });
    renderUi(<FilesScreen />);
    expect(await screen.findByText('File access is switched off')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(invoke.mock.calls.some(([c]) => c === 'files:list')).toBe(false);
  });

  it('with no folders at all it explains how to add one', async () => {
    bridge({}, { overview: overview({ roots: [] }) });
    renderUi(<FilesScreen />);
    expect(await screen.findByText(/Add one to let it work there/)).toBeInTheDocument();
    expect(screen.getByText('No files to show.')).toBeInTheDocument();
  });

  it('reads in Bengali, with Bengali digits and the Bengali refusal text', async () => {
    bridge();
    renderUi(<FilesScreen />, {
      settings: { 'language.ui': 'bn', 'language.numerals': 'bengali' },
    });
    expect(await screen.findByRole('heading', { name: 'ফাইল', level: 1 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Documents' }));
    expect(await screen.findByText('৩টি আইটেম', { exact: false })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /ট্র্যাশে পাঠান/ }).length).toBeGreaterThan(0);
    expect(screen.getByText('নাম')).toBeInTheDocument();
  });

  it('is announced correctly to assistive technology: a named table, a landmark for the path, labelled controls', async () => {
    renderUi(<FilesScreen />);
    await screen.findByRole('table', { name: 'Files' });
    expect(screen.getByRole('navigation', { name: 'Folder path' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show hidden files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});
