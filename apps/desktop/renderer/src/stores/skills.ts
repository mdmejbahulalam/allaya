import { create } from 'zustand';
import type { BuiltInSkillView } from '@allaya/validation';
import { invoke } from '@renderer/lib/api';

interface SkillsState {
  /** The skills that ship with Allaya; null until loaded. Which are on, and the person's own, are settings. */
  skills: BuiltInSkillView[] | null;
  maxCustom: number;
  load: () => Promise<void>;
}

export const useSkillsStore = create<SkillsState>((set) => ({
  skills: null,
  maxCustom: 10,
  async load() {
    const catalog = await invoke('skills:catalog');
    set({ skills: catalog.skills, maxCustom: catalog.maxCustom });
  },
}));
