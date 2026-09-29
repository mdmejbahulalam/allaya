import { create } from 'zustand';
import type { MemoryOverview } from '@allaya/validation';
import { invoke } from '@renderer/lib/api';

interface MemoryState {
  overview: MemoryOverview | null;
  load: () => Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  overview: null,
  async load() {
    set({ overview: await invoke('memory:list') });
  },
}));
