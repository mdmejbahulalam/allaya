import type { Translator } from '@allaya/localization';
import {
  buildTrayMenu,
  trayTooltip,
  type TrayItem,
  type TrayItemId,
  type TrayState,
} from './tray-menu';

/** What the system tray must offer (Electron's `Tray` fits behind a thin adapter). */
export interface TrayPort {
  setToolTip(text: string): void;
  /** Replaces the menu; `click` is called with the id of the chosen item. */
  setMenu(items: TrayItem[], click: (id: TrayItemId) => void): void;
  /** A plain click on the icon. */
  onClick(callback: () => void): void;
  destroy(): void;
}

export interface TrayActions {
  open(): void;
  stop(): void;
  setAutomationsPaused(paused: boolean): void;
  quit(): void;
}

export interface TrayControllerDeps {
  port: TrayPort;
  translator: () => Translator;
  state: () => TrayState;
  actions: TrayActions;
}

/** Keeps the tray's tooltip and menu true to what Allaya is doing, and routes the person's choices. */
export class TrayController {
  constructor(private readonly deps: TrayControllerDeps) {
    deps.port.onClick(() => deps.actions.open());
    this.refresh();
  }

  refresh(): void {
    const { port, translator, state, actions } = this.deps;
    const now = state();
    const t = translator();
    port.setToolTip(trayTooltip(now, t));
    port.setMenu(buildTrayMenu(now, t), (id) => {
      switch (id) {
        case 'open':
          return actions.open();
        case 'stop':
          return actions.stop();
        case 'pause':
          return actions.setAutomationsPaused(true);
        case 'resume':
          return actions.setAutomationsPaused(false);
        case 'quit':
          return actions.quit();
      }
    });
  }

  dispose(): void {
    this.deps.port.destroy();
  }
}
