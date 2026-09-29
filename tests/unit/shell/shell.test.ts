import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from '@allaya/localization';
import { decideClose, shouldStartHidden } from '../../../apps/desktop/main/shell/close-policy';
import { uiLocale } from '../../../apps/desktop/main/shell/locale';
import { syncLoginItem, type LoginItemPort } from '../../../apps/desktop/main/shell/login-item';
import {
  NotificationController,
  type NotifierPort,
} from '../../../apps/desktop/main/shell/notifications';
import { TrayController, type TrayPort } from '../../../apps/desktop/main/shell/tray-controller';
import {
  buildTrayMenu,
  trayTooltip,
  type TrayItem,
  type TrayItemId,
} from '../../../apps/desktop/main/shell/tray-menu';

const en = createTranslator({ locale: 'en' });
const bn = createTranslator({ locale: 'bn' });

describe('what closing the window does', () => {
  it('hides it when Allaya is to keep running in the tray and there is a tray', () => {
    expect(decideClose({ quitting: false, keepInTray: true, trayAvailable: true })).toBe('hide');
  });
  it('really closes when there is no tray to keep it in, or the person turned that off', () => {
    expect(decideClose({ quitting: false, keepInTray: true, trayAvailable: false })).toBe('close');
    expect(decideClose({ quitting: false, keepInTray: false, trayAvailable: true })).toBe('close');
    expect(decideClose({ quitting: false, keepInTray: false, trayAvailable: false })).toBe('close');
  });
  it('never holds back a real quit (tray menu, installer restart, shutdown)', () => {
    expect(decideClose({ quitting: true, keepInTray: true, trayAvailable: true })).toBe('close');
  });
  it('starts in the tray only when the system started it that way and there is a tray', () => {
    expect(shouldStartHidden(['electron', '--hidden'], true)).toBe(true);
    expect(shouldStartHidden(['electron', '--hidden'], false)).toBe(false);
    expect(shouldStartHidden(['electron'], true)).toBe(false);
    expect(shouldStartHidden(['electron', '--hidden-ish'], true)).toBe(false);
  });
});

describe('the language the tray and notifications speak', () => {
  it('follows the setting, else the system', () => {
    expect(uiLocale('bn', 'en-US')).toBe('bn');
    expect(uiLocale('en', 'bn-BD')).toBe('en');
    expect(uiLocale('auto', 'bn-BD')).toBe('bn');
    expect(uiLocale('auto', 'BN')).toBe('bn');
    expect(uiLocale('auto', 'en-GB')).toBe('en');
    expect(uiLocale('auto', 'fr-FR')).toBe('en');
    expect(uiLocale('auto', '')).toBe('en');
  });
});

describe('starting at sign-in', () => {
  const port = (over: Partial<LoginItemPort> & { on?: boolean } = {}) => {
    const state = { on: over.on ?? false, sets: [] as boolean[] };
    const p: LoginItemPort = {
      supported: over.supported ?? true,
      isEnabled: () => state.on,
      set: (enabled) => {
        state.on = enabled;
        state.sets.push(enabled);
      },
    };
    return { p, state };
  };
  it('changes the system only when it differs from the setting', () => {
    const a = port({ on: false });
    expect(syncLoginItem(a.p, true)).toBe('changed');
    expect(a.state.sets).toEqual([true]);
    expect(syncLoginItem(a.p, true)).toBe('unchanged');
    expect(a.state.sets).toEqual([true]);
    expect(syncLoginItem(a.p, false)).toBe('changed');
    expect(a.state.sets).toEqual([true, false]);
  });
  it('never touches it where it is not offered (a development run must not register itself)', () => {
    const a = port({ supported: false, on: false });
    expect(syncLoginItem(a.p, true)).toBe('unsupported');
    expect(a.state.sets).toEqual([]);
  });
});

describe('the tray menu', () => {
  const ids = (items: TrayItem[]) =>
    items.filter((i) => i.type === 'item').map((i) => (i as { id: string }).id);
  it('offers open, stop, pause and quit — and resume instead of pause when automations are paused', () => {
    expect(ids(buildTrayMenu({ activeRuns: 0, automationsPaused: false }, en))).toEqual([
      'open',
      'stop',
      'pause',
      'quit',
    ]);
    expect(ids(buildTrayMenu({ activeRuns: 0, automationsPaused: true }, en))).toEqual([
      'open',
      'stop',
      'resume',
      'quit',
    ]);
  });
  it('is in the person’s language', () => {
    const labels = buildTrayMenu({ activeRuns: 0, automationsPaused: false }, bn)
      .filter((i) => i.type === 'item')
      .map((i) => (i as { label: string }).label);
    for (const label of labels) expect(label).toMatch(/[ঀ-৿]/);
    expect(labels[0]).toBe('Allaya খুলুন');
  });
  it('its tooltip says what Allaya is doing', () => {
    expect(trayTooltip({ activeRuns: 0, automationsPaused: false }, en)).toBe('Allaya — ready');
    expect(trayTooltip({ activeRuns: 2, automationsPaused: false }, en)).toBe('Allaya — working');
    expect(trayTooltip({ activeRuns: 0, automationsPaused: true }, en)).toBe(
      'Allaya — automations are paused',
    );
    // Working outranks paused: the person must see that something is running.
    expect(trayTooltip({ activeRuns: 1, automationsPaused: true }, en)).toBe('Allaya — working');
  });
});

describe('the tray controller', () => {
  function rig(initial = { activeRuns: 0, automationsPaused: false }) {
    const state = { ...initial };
    const seen: {
      tooltip: string[];
      menus: TrayItem[][];
      click?: (id: TrayItemId) => void;
      iconClick?: () => void;
      destroyed: number;
    } = {
      tooltip: [],
      menus: [],
      destroyed: 0,
    };
    const port: TrayPort = {
      setToolTip: (text) => seen.tooltip.push(text),
      setMenu: (items, click) => {
        seen.menus.push(items);
        seen.click = click;
      },
      onClick: (callback) => {
        seen.iconClick = callback;
      },
      destroy: () => {
        seen.destroyed += 1;
      },
    };
    const actions = {
      open: vi.fn(),
      stop: vi.fn(),
      setAutomationsPaused: vi.fn(),
      quit: vi.fn(),
    };
    const controller = new TrayController({
      port,
      translator: () => en,
      state: () => state,
      actions,
    });
    return { state, seen, actions, controller };
  }
  it('shows the state at once, and routes each choice to its action', () => {
    const { seen, actions } = rig();
    expect(seen.tooltip).toEqual(['Allaya — ready']);
    seen.click!('open');
    seen.click!('stop');
    seen.click!('pause');
    seen.click!('quit');
    seen.iconClick!();
    expect(actions.open).toHaveBeenCalledTimes(2);
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(actions.setAutomationsPaused).toHaveBeenCalledWith(true);
    expect(actions.quit).toHaveBeenCalledTimes(1);
  });
  it('follows what Allaya is doing when asked to refresh', () => {
    const { state, seen, actions, controller } = rig();
    state.activeRuns = 1;
    state.automationsPaused = true;
    controller.refresh();
    expect(seen.tooltip.at(-1)).toBe('Allaya — working');
    seen.click!('resume');
    expect(actions.setAutomationsPaused).toHaveBeenCalledWith(false);
  });
  it('is taken down cleanly', () => {
    const { seen, controller } = rig();
    controller.dispose();
    expect(seen.destroyed).toBe(1);
  });
});

describe('desktop notifications', () => {
  function rig(over: { enabled?: boolean; front?: boolean } = {}) {
    const state = { enabled: over.enabled ?? true, front: over.front ?? false, now: 1_000 };
    const shown: Array<{ title: string; body?: string; onClick: () => void }> = [];
    const opened: unknown[] = [];
    const notifier: NotifierPort = { show: (input) => shown.push(input) };
    const controller = new NotificationController({
      notifier,
      enabled: () => state.enabled,
      windowInFront: () => state.front,
      translator: () => en,
      open: (target) => opened.push(target),
      now: () => state.now,
    });
    return { state, shown, opened, controller };
  }
  const task = (
    over: Partial<{ id: string; title: string; state: string; outcome: string }> = {},
  ) => ({
    id: 't1',
    title: 'Tidy up',
    state: 'EXECUTING',
    ...over,
  });

  it('tells the person when a task finishes, fails or needs them — and opens that task when clicked', () => {
    const { controller, shown, opened } = rig();
    controller.taskChanged(task());
    controller.taskChanged(task({ state: 'COMPLETED' }));
    expect(shown.map((n) => n.title)).toEqual(['“Tidy up” is done']);
    shown[0]!.onClick();
    expect(opened).toEqual([{ route: 'tasks', taskId: 't1' }]);

    controller.taskChanged(task({ id: 't2', title: 'Sort', state: 'EXECUTING' }));
    controller.taskChanged(task({ id: 't2', title: 'Sort', state: 'WAITING_FOR_USER' }));
    controller.taskChanged(task({ id: 't3', title: 'Send', state: 'EXECUTING' }));
    controller.taskChanged(task({ id: 't3', title: 'Send', state: 'FAILED' }));
    controller.taskChanged(task({ id: 't4', title: 'Part', state: 'EXECUTING' }));
    controller.taskChanged(
      task({ id: 't4', title: 'Part', state: 'COMPLETED', outcome: 'partial' }),
    );
    expect(shown.map((n) => n.title)).toEqual([
      '“Tidy up” is done',
      '“Sort” needs you',
      '“Send” did not finish',
      '“Part” is partly done',
    ]);
  });

  it('says nothing the first time it sees a task, nor when the state has not changed', () => {
    const { controller, shown } = rig();
    controller.taskChanged(task({ state: 'COMPLETED' }));
    controller.taskChanged(task({ state: 'COMPLETED' }));
    controller.taskChanged(task({ state: 'PAUSED' }));
    expect(shown).toEqual([]);
  });

  it('says nothing while the window is in front (the window is the notification), or when switched off', () => {
    const front = rig({ front: true });
    front.controller.taskChanged(task());
    front.controller.taskChanged(task({ state: 'COMPLETED' }));
    front.controller.confirmationRequested();
    expect(front.shown).toEqual([]);
    const off = rig({ enabled: false });
    off.controller.taskChanged(task());
    off.controller.taskChanged(task({ state: 'COMPLETED' }));
    off.controller.confirmationRequested();
    expect(off.shown).toEqual([]);
  });

  it('a question’s notification never says what is being asked — only that a question is waiting', () => {
    const { controller, shown, opened } = rig();
    controller.confirmationRequested();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: 'Allaya needs your OK',
      body: 'Open Allaya to see what it wants to do.',
    });
    shown[0]!.onClick();
    expect(opened).toEqual([{ route: 'home' }]);
  });

  it('does not repeat itself within a few seconds, but does later', () => {
    const { controller, shown, state } = rig();
    controller.confirmationRequested();
    controller.confirmationRequested();
    state.now += 5_000;
    controller.confirmationRequested();
    expect(shown).toHaveLength(1);
    state.now += 6_000;
    controller.confirmationRequested();
    expect(shown).toHaveLength(2);
  });

  it('speaks Bengali when asked to', () => {
    const controller = new NotificationController({
      notifier: { show: (input) => shown.push(input) },
      enabled: () => true,
      windowInFront: () => false,
      translator: () => bn,
      open: () => undefined,
    });
    const shown: Array<{ title: string; body?: string }> = [];
    controller.confirmationRequested();
    expect(shown[0]!.title).toMatch(/[ঀ-৿]/);
  });
});
