import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionRecord, ConfirmationView } from '@allaya/validation';
import { ActionTimeline } from '../../../apps/desktop/renderer/src/features/tools/action-timeline';
import { ToolConfirmationHost } from '../../../apps/desktop/renderer/src/features/tools/confirmation-host';
import { useToolsStore } from '@renderer/stores/tools';
import { useToastStore } from '@renderer/stores/toasts';
import { renderUi } from '../../helpers/render';

const view = (over: Partial<ConfirmationView> = {}): ConfirmationView => ({
  id: 'confirm_1',
  callId: 'call_1',
  tool: 'delete_files',
  risk: 'HIGH',
  summary: 'Delete 3 files from Downloads',
  subjects: ['delete_files'],
  channels: ['ui', 'voice', 'text'],
  createdAt: 0,
  expiresAt: 60_000,
  ...over,
});

let invoke: ReturnType<typeof vi.fn>;
function bridge(responses: Record<string, unknown> = {}) {
  invoke = vi.fn(async (channel: string) => ({
    ok: true,
    data:
      responses[channel] ??
      (channel === 'tools:listPendingConfirmations' ? [] : { accepted: true }),
  }));
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}

beforeEach(() => {
  useToolsStore.setState({ pending: [], live: {}, settled: {} });
  bridge();
});
afterEach(() => useToastStore.setState({ toasts: [] }));

describe('action timeline', () => {
  const action = (over: Partial<ActionRecord> = {}): ActionRecord => ({
    callId: 'c1',
    tool: 'open_folder',
    summary: 'Open Downloads',
    status: 'success',
    ...over,
  });

  it('renders nothing for no actions', () => {
    const { container } = renderUi(<ActionTimeline actions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the outcome and, for a verified effect, that it was checked', () => {
    renderUi(<ActionTimeline actions={[action({ verification: 'verified', risk: 'MEDIUM' })]} />);
    const step = screen.getByRole('listitem');
    expect(step).toHaveTextContent('Open Downloads');
    expect(step).toHaveTextContent('Done');
    expect(step).toHaveTextContent('Checked');
    expect(step).toHaveTextContent('Medium risk');
  });

  it('never presents an unchecked effect as simply "done"', () => {
    renderUi(<ActionTimeline actions={[action({ verification: 'unverified' })]} />);
    expect(screen.getByRole('listitem')).toHaveTextContent('Not checked');
  });

  it('says nothing about checking for read-only actions', () => {
    renderUi(<ActionTimeline actions={[action({ verification: 'not_applicable' })]} />);
    const step = screen.getByRole('listitem');
    expect(step).not.toHaveTextContent('Checked');
    expect(step).not.toHaveTextContent('Not checked');
  });

  it('shows why an action did not happen', () => {
    renderUi(
      <ActionTimeline
        actions={[
          action({
            status: 'denied',
            error: "This is turned off in the user's permission settings",
          }),
        ]}
      />,
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('Not allowed');
    expect(screen.getByRole('listitem')).toHaveTextContent('turned off');
  });

  it.each([
    ['running', 'Working…'],
    ['awaiting_confirmation', 'Waiting for you'],
    ['failed', "Didn't work"],
    ['rejected', 'You said no'],
    ['cancelled', 'Stopped'],
  ] as const)('labels %s', (status, label) => {
    renderUi(<ActionTimeline actions={[action({ status })]} />);
    expect(screen.getByRole('listitem')).toHaveTextContent(label);
    expect(screen.getByRole('listitem')).toHaveAttribute('data-status', status);
  });

  it('is localised', () => {
    renderUi(<ActionTimeline actions={[action({ verification: 'verified' })]} />, {
      settings: { 'language.ui': 'bn' },
    });
    const step = screen.getByRole('listitem');
    expect(step).toHaveTextContent('হয়েছে');
    expect(step).toHaveTextContent('যাচাই হয়েছে');
  });
});

describe('confirmation dialog', () => {
  it('shows nothing when nothing is pending', () => {
    renderUi(<ToolConfirmationHost />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks exactly what will happen, with safe defaults: focus on "Don\'t allow"', async () => {
    renderUi(<ToolConfirmationHost />);
    act(() => useToolsStore.getState().addPending(view()));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete 3 files from Downloads');
    expect(dialog).toHaveTextContent('High risk');
    expect(within(dialog).getByRole('button', { name: "Don't allow" })).toHaveFocus();
  });

  it('approving sends "approved" for that exact question and closes it', async () => {
    renderUi(<ToolConfirmationHost />);
    act(() => useToolsStore.getState().addPending(view()));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tools:respondConfirmation', {
        id: 'confirm_1',
        decision: 'approved',
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('declining — by button or Escape — sends "rejected"', async () => {
    renderUi(<ToolConfirmationHost />);
    act(() => useToolsStore.getState().addPending(view()));
    await userEvent.click(await screen.findByRole('button', { name: "Don't allow" }));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tools:respondConfirmation', {
        id: 'confirm_1',
        decision: 'rejected',
      }),
    );

    act(() => useToolsStore.getState().addPending(view({ id: 'confirm_2' })));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tools:respondConfirmation', {
        id: 'confirm_2',
        decision: 'rejected',
      }),
    );
  });

  it('"Stop everything" invokes the emergency stop from inside the dialog', async () => {
    renderUi(<ToolConfirmationHost />);
    act(() => useToolsStore.getState().addPending(view()));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop everything' }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('agent:stop'));
  });

  it('CRITICAL actions say the answer must be given on the screen; others offer voice', async () => {
    renderUi(<ToolConfirmationHost />);
    act(() => useToolsStore.getState().addPending(view({ risk: 'CRITICAL', channels: ['ui'] })));
    expect(await screen.findByRole('dialog')).toHaveTextContent('confirmed here on the screen');
    act(() => useToolsStore.getState().resolvePending('confirm_1'));
    act(() => useToolsStore.getState().addPending(view({ id: 'confirm_3' })));
    expect(await screen.findByRole('dialog')).toHaveTextContent('answer by voice');
  });

  it('queues several questions and shows them one at a time', async () => {
    renderUi(<ToolConfirmationHost />);
    act(() => {
      useToolsStore.getState().addPending(view({ id: 'a', summary: 'First thing' }));
      useToolsStore.getState().addPending(view({ id: 'b', summary: 'Second thing' }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('First thing');
    expect(dialog).toHaveTextContent('1 more waiting');
    await userEvent.click(within(dialog).getByRole('button', { name: "Don't allow" }));
    await vi.waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Second thing'));
  });

  it('tells the user when an approval arrives too late', async () => {
    bridge({ 'tools:respondConfirmation': { accepted: false } });
    renderUi(<ToolConfirmationHost />);
    act(() => useToolsStore.getState().addPending(view()));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
    await vi.waitFor(() =>
      expect(JSON.stringify(useToastStore.getState().toasts)).toContain('no longer open'),
    );
  });

  it('reloads a question that was already open (e.g. after a window reload)', async () => {
    bridge({ 'tools:listPendingConfirmations': [view({ summary: 'Still waiting' })] });
    renderUi(<ToolConfirmationHost />);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Still waiting');
  });

  it('is localised', async () => {
    renderUi(<ToolConfirmationHost />, { settings: { 'language.ui': 'bn' } });
    act(() =>
      useToolsStore
        .getState()
        .addPending(view({ summary: 'ডাউনলোডস থেকে ৩টি ফাইল মুছে ফেলা হবে' })),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'একবার অনুমতি দিন' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'অনুমতি দেবেন না' })).toBeInTheDocument();
  });
});

describe('tools store', () => {
  it('a slow snapshot never wipes a question that an event delivered in the meantime', async () => {
    let release!: (v: ConfirmationView[]) => void;
    invoke = vi.fn(
      () => new Promise((resolve) => (release = (v) => resolve({ ok: true, data: v }))),
    );
    (window as unknown as { allaya: unknown }).allaya = {
      invoke,
      subscribe: () => () => undefined,
    };
    const loading = useToolsStore.getState().load();
    useToolsStore.getState().addPending(view({ id: 'pushed' })); // the event arrives first…
    release([]); // …then the older, empty snapshot
    await loading;
    expect(useToolsStore.getState().pending.map((p) => p.id)).toEqual(['pushed']);
  });

  it('a snapshot cannot resurrect a question an event already settled', async () => {
    useToolsStore.getState().resolvePending('gone');
    let release!: (v: ConfirmationView[]) => void;
    invoke = vi.fn(
      () => new Promise((resolve) => (release = (v) => resolve({ ok: true, data: v }))),
    );
    (window as unknown as { allaya: unknown }).allaya = {
      invoke,
      subscribe: () => () => undefined,
    };
    const loading = useToolsStore.getState().load();
    release([view({ id: 'gone' }), view({ id: 'still', createdAt: 5 })]);
    await loading;
    expect(useToolsStore.getState().pending.map((p) => p.id)).toEqual(['still']);
  });

  it('ignores a duplicate question and drops a resolved one', () => {
    const { addPending, resolvePending } = useToolsStore.getState();
    addPending(view());
    addPending(view());
    expect(useToolsStore.getState().pending).toHaveLength(1);
    resolvePending('confirm_1');
    expect(useToolsStore.getState().pending).toEqual([]);
  });

  it('merges live action updates by call id, in order', () => {
    const { applyActivity } = useToolsStore.getState();
    applyActivity('m1', { callId: 'a', tool: 't', summary: 'Do it', status: 'running' });
    applyActivity('m1', { callId: 'b', tool: 't', summary: 'Then this', status: 'running' });
    applyActivity('m1', {
      callId: 'a',
      tool: 't',
      summary: 'Do it',
      status: 'success',
      verification: 'verified',
    });
    expect(useToolsStore.getState().live['m1']).toEqual([
      { callId: 'a', tool: 't', summary: 'Do it', status: 'success', verification: 'verified' },
      { callId: 'b', tool: 't', summary: 'Then this', status: 'running' },
    ]);
  });
});
