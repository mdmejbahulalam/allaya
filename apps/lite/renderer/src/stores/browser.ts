import { create } from 'zustand';
import type { BrowserState } from '../../../shared/ipc';
import { invoke } from '../lib/api';

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 520;

interface BrowserStore {
  state: BrowserState;
  /** The pane is showing beside the chat. */
  open: boolean;
  width: number;
  /** A file a page offered and the browser refused to save. */
  refused: string | null;
  load: () => Promise<void>;
  setState: (state: BrowserState) => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  refuse: (filename: string | null) => void;
}

export const useBrowserStore = create<BrowserStore>((set) => ({
  state: { tabs: [], activeId: null },
  open: false,
  width: DEFAULT_WIDTH,
  refused: null,
  async load() {
    set({ state: await invoke('browser:state') });
  },
  setState: (state) => set({ state }),
  setOpen: (open) => set({ open }),
  setWidth: (width) => set({ width: Math.max(MIN_WIDTH, Math.round(width)) }),
  refuse: (refused) => set({ refused }),
}));

export const MIN_PANE_WIDTH = MIN_WIDTH;

export const activeTab = (state: BrowserState) => state.tabs.find((t) => t.id === state.activeId);
