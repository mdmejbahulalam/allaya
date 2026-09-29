import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionCard } from '@renderer/components/domain/permission-card';
import { Timeline } from '@renderer/components/domain/timeline';
import { VoiceVisualizer } from '@renderer/components/domain/voice-visualizer';
import { AIStatus } from '@renderer/components/domain/ai-status';
import { TaskCard } from '@renderer/components/domain/task-card';
import { CommandPalette, type PaletteItem } from '@renderer/components/shell/command-palette';
import { Button } from '@renderer/components/ui/button';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { DataTable } from '@renderer/components/ui/data-table';
import { Drawer } from '@renderer/components/ui/drawer';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Field, Input, Textarea } from '@renderer/components/ui/input';
import { Modal } from '@renderer/components/ui/modal';
import { Switch } from '@renderer/components/ui/switch';
import { Tabs } from '@renderer/components/ui/tabs';
import { Toaster } from '@renderer/components/ui/toast';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { toast } from '@renderer/stores/toasts';
import { renderUi } from '../../helpers/render';

beforeEach(() => vi.useRealTimers());

describe('Button / IconButton', () => {
  it('loading disables the button and announces busy state', () => {
    const onClick = vi.fn();
    renderUi(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: /save/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('icon buttons are named for assistive tech', () => {
    renderUi(<IconButton label="Open settings" icon={<span>⚙</span>} />);
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument();
  });
});

describe('Field wiring', () => {
  it('associates label, hint and error with the control', () => {
    renderUi(
      <Field label="Name" error="Required">
        {(p) => <Input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('Required');
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
  });

  it('Textarea auto-grow does not crash without layout (jsdom)', () => {
    renderUi(<Textarea autoGrow aria-label="ask" defaultValue="hello" />);
    expect(screen.getByLabelText('ask')).toBeInTheDocument();
  });
});

describe('Modal', () => {
  function Harness({ onOpen }: { onOpen?: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button
          onClick={() => {
            setOpen(true);
            onOpen?.();
          }}
        >
          reopen
        </button>
        <Modal
          open={open}
          onOpenChange={setOpen}
          title="Rename"
          description="Pick a name"
          footer={<Button>OK</Button>}
        >
          <Input aria-label="new name" />
        </Modal>
      </>
    );
  }

  it('is a labelled dialog and closes on Escape', async () => {
    renderUi(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Rename' });
    expect(dialog).toHaveAccessibleDescription('Pick a name');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('close button is localized', async () => {
    renderUi(<Harness />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByRole('button', { name: 'বন্ধ করুন' })).toBeInTheDocument();
  });
});

describe('ConfirmationDialog safety defaults', () => {
  const setup = (risk: 'MEDIUM' | 'HIGH' = 'HIGH') => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const onReview = vi.fn();
    renderUi(
      <ConfirmationDialog
        open
        risk={risk}
        message="Allaya wants to delete 17 files."
        location="Downloads/Old Files"
        onConfirm={onConfirm}
        onCancel={onCancel}
        onReview={onReview}
      />,
    );
    return { onConfirm, onCancel, onReview };
  };

  it('focuses Cancel first — Enter/Space cannot accidentally confirm', async () => {
    setup();
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
  });

  it('Escape cancels and never confirms', async () => {
    const { onCancel, onConfirm } = setup();
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('only the explicit Confirm button proceeds; shows the target and irreversibility warning', async () => {
    const { onConfirm } = setup('HIGH');
    expect(await screen.findByText('Downloads/Old Files')).toBeInTheDocument();
    expect(screen.getByText('This action may not be reversible.')).toBeInTheDocument();
    expect(screen.getByText('High risk')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('lower-risk confirmations do not claim irreversibility', async () => {
    setup('MEDIUM');
    await screen.findByRole('dialog');
    expect(screen.queryByText('This action may not be reversible.')).not.toBeInTheDocument();
  });

  it('is fully localized in Bengali', async () => {
    renderUi(
      <ConfirmationDialog
        open
        risk="HIGH"
        message="msg"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
      { settings: { 'language.ui': 'bn' } },
    );
    expect(await screen.findByText('নিশ্চিতকরণ প্রয়োজন')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'বাতিল' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'নিশ্চিত করুন' })).toBeInTheDocument();
  });
});

describe('Drawer', () => {
  it('renders as a labelled dialog', async () => {
    renderUi(
      <Drawer open onOpenChange={() => undefined} title="Live activity">
        <p>body</p>
      </Drawer>,
    );
    expect(await screen.findByRole('dialog', { name: 'Live activity' })).toBeInTheDocument();
  });
});

describe('Toasts', () => {
  it('errors interrupt (role=alert); others are polite (role=status); dismissable', async () => {
    renderUi(<Toaster />);
    act(() => {
      toast.error('Boom');
      toast.success('Yay');
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    expect(screen.getByRole('status')).toHaveTextContent('Yay');
    await userEvent.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('caps the stack so notifications cannot flood the screen', () => {
    renderUi(<Toaster />);
    act(() => {
      for (let i = 0; i < 12; i += 1) toast.info(`n${i}`, { duration: 0 });
    });
    expect(screen.getAllByRole('status').length).toBeLessThanOrEqual(5);
  });

  it('auto-dismisses timed toasts and keeps errors until dismissed', async () => {
    vi.useFakeTimers();
    renderUi(<Toaster />);
    act(() => {
      toast.info('timed', { duration: 1000 });
      toast.error('sticky');
    });
    expect(screen.getByText('timed')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.queryByText('timed')).not.toBeInTheDocument();
    expect(screen.getByText('sticky')).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('Tooltip', () => {
  it('is suppressed while an overlay is open (must not swallow Escape)', async () => {
    renderUi(
      <>
        <Tooltip label="Tip">
          <button>trigger</button>
        </Tooltip>
        <Modal open onOpenChange={() => undefined} title="Dialog">
          <p>x</p>
        </Modal>
      </>,
    );
    await screen.findByRole('dialog');
    fireEvent.pointerMove(screen.getByText('trigger', { selector: 'button' }));
    fireEvent.focus(screen.getByText('trigger', { selector: 'button' }));
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

describe('Tabs & Switch', () => {
  it('tabs expose selected state and counts', async () => {
    const onChange = vi.fn();
    renderUi(
      <Tabs
        label="Tasks"
        value="all"
        onValueChange={onChange}
        items={[
          { value: 'all', label: 'All', count: 3 },
          { value: 'failed', label: 'Failed' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Failed' }));
    expect(onChange).toHaveBeenCalledWith('failed');
  });

  it('switch toggles and is labelled', async () => {
    const onChange = vi.fn();
    renderUi(<Switch label="Glass" checked={false} onCheckedChange={onChange} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Glass' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('DataTable', () => {
  const columns = [{ id: 'n', header: 'Name', cell: (r: { n: string }) => r.n }];
  it('has an accessible caption and column headers', () => {
    renderUi(
      <DataTable caption="Files" columns={columns} rows={[{ n: 'a.pdf' }]} rowKey={(r) => r.n} />,
    );
    expect(screen.getByRole('table', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
  });
  it('shows skeleton rows while loading and the empty state when empty', () => {
    const { rerender } = renderUi(
      <DataTable
        caption="Files"
        loading
        columns={columns}
        rows={[]}
        rowKey={(r) => r.n}
        empty={<p>none</p>}
      />,
    );
    expect(screen.queryByText('none')).not.toBeInTheDocument();
    rerender(
      <DataTable
        caption="Files"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.n}
        empty={<p>none</p>}
      />,
    );
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});

describe('Domain components', () => {
  it('Timeline shows per-step state and expandable detail', async () => {
    renderUi(
      <Timeline
        steps={[
          { id: '1', title: 'Understand request', state: 'done' },
          {
            id: '2',
            title: 'Open Downloads',
            state: 'running',
            detail: 'open_folder {"target":"Downloads"}',
          },
          { id: '3', title: 'Prepare results', state: 'pending' },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText(/open_folder/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/open_folder/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('PermissionCard is a radiogroup with exactly one checked mode', async () => {
    const onChange = vi.fn();
    renderUi(<PermissionCard subject="delete_files" mode="ask" onModeChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Delete files' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    await userEvent.click(within(group).getByRole('radio', { name: 'Never allow' }));
    expect(onChange).toHaveBeenCalledWith('never');
  });

  it('VoiceVisualizer and AIStatus expose localized state names', () => {
    renderUi(
      <>
        <VoiceVisualizer state="LISTENING" />
        <AIStatus status="working" detail="Opening Chrome" />
      </>,
      { settings: { 'language.ui': 'bn' } },
    );
    expect(screen.getByRole('img', { name: 'শুনছি' })).toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('কাজ করছি');
    expect(status).toHaveTextContent('Opening Chrome');
  });

  it('TaskCard offers Retry only for failed or cancelled tasks, and formats numbers in Bengali', async () => {
    const onRetry = vi.fn();
    const base = {
      id: '1',
      title: 'Find PDFs',
      startedAt: Date.now() - 60_000,
      durationMs: 42_000,
      actionCount: 6,
      filesChanged: 12,
    };
    const { rerender } = renderUi(
      <TaskCard
        task={{ ...base, state: 'COMPLETED' }}
        onOpen={() => undefined}
        onRetry={onRetry}
      />,
      { settings: { 'language.ui': 'bn' } },
    );
    expect(screen.queryByRole('button', { name: 'আবার চেষ্টা করুন' })).not.toBeInTheDocument();
    expect(screen.getByText('৬টি অ্যাকশন')).toBeInTheDocument();
    expect(screen.getByText('১২টি ফাইল পরিবর্তিত')).toBeInTheDocument();
    rerender(
      <TaskCard task={{ ...base, state: 'FAILED' }} onOpen={() => undefined} onRetry={onRetry} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'আবার চেষ্টা করুন' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('CommandPalette', () => {
  const run = vi.fn();
  const items: PaletteItem[] = [
    { id: 'a', label: 'Open Downloads', group: 'suggested', keywords: ['ডাউনলোড'], run },
    { id: 'b', label: 'Open settings', group: 'navigate', keywords: ['সেটিংস'], run: vi.fn() },
  ];
  const setup = () => {
    const onOpenChange = vi.fn();
    const onAsk = vi.fn();
    renderUi(<CommandPalette open onOpenChange={onOpenChange} items={items} onAsk={onAsk} />);
    return { onOpenChange, onAsk, input: () => screen.findByRole('combobox') };
  };

  it('is a combobox/listbox with aria-activedescendant tracking the highlighted option', async () => {
    const { input } = setup();
    const box = await input();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await userEvent.keyboard('{ArrowDown}');
    expect(box.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}'); // wraps
    expect(box.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
  });

  it('runs the highlighted item on Enter and closes', async () => {
    const { onOpenChange } = setup();
    await screen.findByRole('combobox');
    await userEvent.keyboard('{Enter}');
    expect(run).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('free text becomes an "Ask Allaya" item that comes first', async () => {
    const { onAsk } = setup();
    await userEvent.type(await screen.findByRole('combobox'), 'zzz unknown thing');
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Ask Allaya: “zzz unknown thing”');
    await userEvent.keyboard('{Enter}');
    expect(onAsk).toHaveBeenCalledWith('zzz unknown thing');
  });

  it('finds items by Bengali keyword', async () => {
    setup();
    await userEvent.type(await screen.findByRole('combobox'), 'ডাউনলোড');
    expect(screen.getByRole('option', { name: /Open Downloads/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Open settings/ })).not.toBeInTheDocument();
  });

  it('does not fire Enter while an IME composition is active (Bengali input methods)', async () => {
    const { onAsk } = setup();
    const box = await screen.findByRole('combobox');
    fireEvent.change(box, { target: { value: 'আমি' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onAsk).toHaveBeenCalledWith('আমি');
  });
});
