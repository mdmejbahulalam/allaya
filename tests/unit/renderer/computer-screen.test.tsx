import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerStatus, SelfTestResult } from '@allaya/validation';
import { ComputerScreen } from '../../../apps/desktop/renderer/src/features/computer/computer-screen';
import { renderUi } from '../../helpers/render';

const windowsStatus: ComputerStatus = {
  platform: 'win32',
  adapter: 'windows+host',
  capabilities: {
    windows: true,
    launch: true,
    screenshot: true,
    clipboard: true,
    mouse: true,
    keyboard: true,
    uiAutomation: true,
  },
  tools: [
    { name: 'open_app', category: 'applications', readOnly: false, risk: 'varies' },
    { name: 'list_windows', category: 'computer', readOnly: true, risk: 'LOW' },
    { name: 'click_at', category: 'computer', readOnly: false, risk: 'HIGH' },
  ],
  screenshotsFolder: 'C:\\Users\\me\\Pictures\\Allaya',
};
const linuxStatus: ComputerStatus = {
  platform: 'linux',
  adapter: 'host-only',
  capabilities: {
    windows: false,
    launch: false,
    screenshot: true,
    clipboard: true,
    mouse: false,
    keyboard: false,
    uiAutomation: false,
  },
  tools: [{ name: 'take_screenshot', category: 'computer', readOnly: false, risk: 'LOW' }],
};

let invoke: ReturnType<typeof vi.fn>;
function bridge(status: ComputerStatus, selfTest?: SelfTestResult | Error) {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'computer:getStatus') return { ok: true, data: status };
    if (channel === 'computer:selfTest') {
      if (selfTest instanceof Error)
        return { ok: false, error: { code: 'INTERNAL', message: 'x', retryable: false } };
      return { ok: true, data: selfTest };
    }
    return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: channel, retryable: false } };
  });
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}

beforeEach(() => bridge(windowsStatus));

describe('Computer screen', () => {
  it('shows every ability as available on a full Windows setup, with the screenshots folder', async () => {
    renderUi(<ComputerScreen />);
    expect(await screen.findByText('Type and press shortcuts')).toBeInTheDocument();
    for (const li of document.querySelectorAll('[data-available]'))
      expect(li.getAttribute('data-available')).toBe('true');
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByText('C:\\Users\\me\\Pictures\\Allaya')).toBeInTheDocument();
  });

  it('lists tools with how risky each is treated; blind clicks are flagged high', async () => {
    renderUi(<ComputerScreen />);
    const row = (await screen.findByText('click_at')).closest('li')!;
    expect(within(row).getByText('High risk')).toBeInTheDocument();
    expect(within(row).getByText('Changes things')).toBeInTheDocument();
    const listWindows = screen.getByText('list_windows').closest('li')!;
    expect(within(listWindows).getByText('Low risk')).toBeInTheDocument();
    expect(within(listWindows).getByText('Only looks')).toBeInTheDocument();
    expect(
      within(screen.getByText('open_app').closest('li')!).getByText('Depends on the request'),
    ).toBeInTheDocument();
  });

  it('on a machine without input control it says so plainly and lists only what works', async () => {
    bridge(linuxStatus);
    renderUi(<ComputerScreen />);
    expect(await screen.findByRole('note')).toHaveTextContent('Windows only');
    expect(document.querySelector('[data-available="false"]')).not.toBeNull();
    expect(screen.getByText('take_screenshot')).toBeInTheDocument();
    expect(screen.queryByText('type_text')).toBeNull();
  });

  it('runs the safe self-check and reports each step, distinguishing "skipped" from "failed"', async () => {
    bridge(windowsStatus, {
      ok: false,
      steps: [
        { name: 'platform', ok: true, detail: 'win32 · windows+host' },
        { name: 'list windows', ok: false, detail: 'Could not start Windows PowerShell' },
        { name: 'capture screen', ok: true, skipped: true, detail: 'Not available' },
      ],
    });
    renderUi(<ComputerScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run a safe check' }));
    const report = await screen.findByRole('status');
    expect(report).toHaveTextContent("Something didn't respond");
    expect(report).toHaveTextContent('Could not start Windows PowerShell');
    expect(report.querySelector('[data-skipped="true"]')).toHaveTextContent('Capture the screen');
    expect(invoke).toHaveBeenCalledWith('computer:selfTest');
  });

  it('a passing self-check says everything responded', async () => {
    bridge(windowsStatus, { ok: true, steps: [{ name: 'platform', ok: true, detail: 'win32' }] });
    renderUi(<ComputerScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run a safe check' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Everything responded.');
  });

  it('shows an error state rather than a blank page when the status cannot be read', async () => {
    invoke = vi.fn(async () => ({
      ok: false,
      error: { code: 'INTERNAL', message: 'x', retryable: false },
    }));
    (window as unknown as { allaya: unknown }).allaya = {
      invoke,
      subscribe: () => () => undefined,
    };
    renderUi(<ComputerScreen />);
    await waitFor(() => expect(screen.getByText('Something went wrong.')).toBeInTheDocument());
  });

  it('is fully localised', async () => {
    renderUi(<ComputerScreen />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByText('টাইপ করা ও শর্টকাট চাপা')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'নিরাপদ যাচাই চালান' })).toBeInTheDocument();
  });
});
