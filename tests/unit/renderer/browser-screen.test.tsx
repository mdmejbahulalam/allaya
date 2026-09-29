import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults, type BrowserStatus } from '@allaya/validation';
import { BrowserScreen } from '../../../apps/desktop/renderer/src/features/browser/browser-screen';
import { useToastStore } from '@renderer/stores/toasts';
import { renderUi } from '../../helpers/render';

const base: BrowserStatus = {
  available: true,
  engine: 'edge',
  running: false,
  headless: false,
  tabs: [],
  trustedDomains: ['wikipedia.org'],
  blockedDomains: [],
  profileFolder: 'C:\\Users\\me\\AppData\\Roaming\\Allaya\\browser-profile',
  tools: [
    { name: 'browser_open', readOnly: false, risk: 'varies' },
    { name: 'browser_read', readOnly: true, risk: 'LOW' },
    { name: 'browser_click', readOnly: false, risk: 'varies' },
  ],
};

let invoke: ReturnType<typeof vi.fn>;
let listeners: Array<(payload: unknown) => void>;
let status: BrowserStatus;

function bridge(
  handlers: Record<string, (payload: never) => unknown> = {},
  initial: BrowserStatus = base,
) {
  status = initial;
  listeners = [];
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const custom = handlers[channel];
    if (custom) {
      const value = await custom(payload as never);
      if (value && typeof value === 'object' && '__error' in value)
        return { ok: false, error: value.__error };
      return { ok: true, data: value };
    }
    if (channel === 'browser:getStatus') return { ok: true, data: status };
    if (channel === 'settings:set') {
      const { key, value } = payload as { key: string; value: unknown };
      return { ok: true, data: { ...settingsDefaults, 'language.ui': 'en', [key]: value } };
    }
    return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: channel, retryable: false } };
  });
  (window as unknown as { allaya: unknown }).allaya = {
    invoke,
    subscribe: (_c: string, l: (p: unknown) => void) => {
      listeners.push(l);
      return () => undefined;
    },
  };
}

beforeEach(() => bridge());

describe('Browser screen', () => {
  it('shows which browser is used and that it is not open', async () => {
    renderUi(<BrowserScreen />);
    expect(await screen.findByText('Microsoft Edge')).toBeInTheDocument();
    expect(screen.getByText('Not open')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close browser' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open browser window' })).toBeEnabled();
  });

  it('says plainly when no compatible browser is installed, and offers nothing that cannot work', async () => {
    bridge({}, { ...base, available: false, engine: null, tools: [] });
    renderUi(<BrowserScreen />);
    expect(await screen.findByText('No compatible browser found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open browser window' })).toBeNull();
    expect(screen.getByText('The browser is not available on this computer.')).toBeInTheDocument();
  });

  it('opens the window for the user to sign in, and closes it', async () => {
    const running: BrowserStatus = {
      ...base,
      running: true,
      tabs: [
        {
          id: 't1',
          title: 'Wikipedia',
          url: 'https://en.wikipedia.org/wiki/Dhaka?…',
          active: true,
        },
      ],
    };
    bridge({
      'browser:openWindow': () => (status = running),
      'browser:close': () => (status = base),
    });
    renderUi(<BrowserScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open browser window' }));
    expect(await screen.findByText('Wikipedia')).toBeInTheDocument();
    expect(screen.getByText('Open in a visible window')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('browser:openWindow', {});
    await userEvent.click(screen.getByRole('button', { name: 'Close browser' }));
    await waitFor(() => expect(screen.queryByText('Wikipedia')).toBeNull());
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('The browser was closed.');
  });

  it('lists tabs with addresses that carry no query string', async () => {
    bridge(
      {},
      {
        ...base,
        running: true,
        tabs: [{ id: 't1', title: '', url: 'https://shop.example/cart?…', active: false }],
      },
    );
    renderUi(<BrowserScreen />);
    const tabs = await screen.findByRole('list', { name: 'Open tabs' });
    expect(within(tabs).getByText('(untitled)')).toBeInTheDocument();
    expect(within(tabs).getByText('https://shop.example/cart?…')).toBeInTheDocument();
    expect(within(tabs).queryByText('Current')).toBeNull();
  });

  it('adds a trusted site, and the list follows what the backend says', async () => {
    bridge({
      'browser:setDomain': ({
        list,
        domain,
        present,
      }: {
        list: string;
        domain: string;
        present: boolean;
      }) =>
        (status = {
          ...status,
          ...(list === 'trusted'
            ? {
                trustedDomains: present
                  ? [...status.trustedDomains, domain.toLowerCase()]
                  : status.trustedDomains.filter((d) => d !== domain),
              }
            : {}),
        }),
    });
    renderUi(<BrowserScreen />);
    const trusted = (await screen.findByRole('heading', { name: 'Trusted sites' })).closest(
      '[data-list]',
    ) as HTMLElement;
    expect(within(trusted).getByText('wikipedia.org')).toBeInTheDocument();
    await userEvent.type(within(trusted).getByLabelText('Add a site'), 'Example.COM');
    await userEvent.click(within(trusted).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('browser:setDomain', {
        list: 'trusted',
        domain: 'Example.COM',
        present: true,
      }),
    );
    expect(await within(trusted).findByText('example.com')).toBeInTheDocument();
    expect(within(trusted).getByLabelText('Add a site')).toHaveValue('');
    await userEvent.click(within(trusted).getByRole('button', { name: 'Remove wikipedia.org' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('browser:setDomain', {
        list: 'trusted',
        domain: 'wikipedia.org',
        present: false,
      }),
    );
  });

  it('explains a rejected site name in words', async () => {
    bridge({
      'browser:setDomain': () => ({
        __error: {
          code: 'INVALID_INPUT',
          message: 'x',
          retryable: false,
          details: { reason: 'invalid_url' },
        },
      }),
    });
    renderUi(<BrowserScreen />);
    const blocked = (await screen.findByRole('heading', { name: 'Blocked sites' })).closest(
      '[data-list]',
    ) as HTMLElement;
    await userEvent.type(within(blocked).getByLabelText('Add a site'), 'not a site');
    await userEvent.click(within(blocked).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
        'That is not a valid web address.',
      ),
    );
    expect(within(blocked).getByText('No blocked sites.')).toBeInTheDocument();
  });

  it('will not submit an empty site name', async () => {
    renderUi(<BrowserScreen />);
    const blocked = (await screen.findByRole('heading', { name: 'Blocked sites' })).closest(
      '[data-list]',
    ) as HTMLElement;
    expect(within(blocked).getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('states what Allaya will not do, and lists the tools with their risk', async () => {
    renderUi(<BrowserScreen />);
    expect(
      await screen.findByText(/Type passwords, card numbers or verification codes/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Follow instructions written on a web page/)).toBeInTheDocument();
    const open = screen.getByText('browser_open').closest('li')!;
    expect(within(open).getByText('Depends on the request')).toBeInTheDocument();
    const read = screen.getByText('browser_read').closest('li')!;
    expect(within(read).getByText('Low risk')).toBeInTheDocument();
    expect(within(read).getByText('Only looks')).toBeInTheDocument();
  });

  it('the hidden-window setting is a labelled switch that saves through settings', async () => {
    renderUi(<BrowserScreen />);
    const toggle = await screen.findByRole('switch', { name: 'Run the browser without a window' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', { key: 'browser.headless', value: true }),
    );
  });

  it('refreshes when the backend reports a change', async () => {
    renderUi(<BrowserScreen />);
    await screen.findByText('Not open');
    const before = invoke.mock.calls.filter(([c]) => c === 'browser:getStatus').length;
    listeners.forEach((l) => l({}));
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === 'browser:getStatus').length).toBeGreaterThan(
        before,
      ),
    );
  });

  it('reads in Bengali', async () => {
    renderUi(<BrowserScreen />, { settings: { 'language.ui': 'bn' } });
    expect(await screen.findByText('মাইক্রোসফট এজ')).toBeInTheDocument();
    expect(screen.getByText('ব্রাউজার উইন্ডো খুলুন', { selector: 'button' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'বিশ্বস্ত সাইট' })).toBeInTheDocument();
  });
});
