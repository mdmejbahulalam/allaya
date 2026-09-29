import { create } from 'zustand';
import type { AutomationsOverview } from '@allaya/validation';
import { invoke } from '@renderer/lib/api';

interface AutomationsState {
  overview: AutomationsOverview | null;
  load: () => Promise<void>;
}

export const useAutomationsStore = create<AutomationsState>((set) => ({
  overview: null,
  async load() {
    set({ overview: await invoke('automations:list') });
  },
}));
