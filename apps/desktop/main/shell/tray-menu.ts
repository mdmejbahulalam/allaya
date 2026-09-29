import type { Translator } from '@allaya/localization';

export interface TrayState {
  /** Runs in progress (chat replies, tasks, listening). */
  activeRuns: number;
  /** The emergency stop paused every schedule. */
  automationsPaused: boolean;
}

export type TrayItemId = 'open' | 'stop' | 'pause' | 'resume' | 'quit';

export type TrayItem = { type: 'item'; id: TrayItemId; label: string } | { type: 'separator' };

/** The tray menu for the present state. Only what makes sense right now is offered (pause or resume, never both). */
export function buildTrayMenu(state: TrayState, t: Translator): TrayItem[] {
  return [
    { type: 'item', id: 'open', label: t.t('tray.open') },
    { type: 'separator' },
    { type: 'item', id: 'stop', label: t.t('tray.stop') },
    state.automationsPaused
      ? { type: 'item', id: 'resume', label: t.t('tray.resumeAutomations') }
      : { type: 'item', id: 'pause', label: t.t('tray.pauseAutomations') },
    { type: 'separator' },
    { type: 'item', id: 'quit', label: t.t('tray.quit') },
  ];
}

export function trayTooltip(state: TrayState, t: Translator): string {
  if (state.activeRuns > 0) return t.t('tray.tooltip.working');
  return t.t(state.automationsPaused ? 'tray.tooltip.paused' : 'tray.tooltip.idle');
}
