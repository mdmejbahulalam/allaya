import { create } from 'zustand';
import {
  settingsDefaults,
  type SettingKey,
  type SettingValue,
  type SettingsSnapshot,
} from '@allaya/validation';
import { invoke } from '@renderer/lib/api';

interface SettingsState {
  values: SettingsSnapshot;
  hydrated: boolean;
  hydrate: (snapshot: SettingsSnapshot) => void;
  /** Optimistically applies, persists through main, and rolls back on failure. */
  update: <K extends SettingKey>(key: K, value: SettingValue<K>) => Promise<void>;
  reset: (key: SettingKey) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  values: settingsDefaults,
  hydrated: false,
  hydrate: (snapshot) => set({ values: snapshot, hydrated: true }),
  async update(key, value) {
    const previous = get().values;
    set({ values: { ...previous, [key]: value } });
    try {
      const snapshot = await invoke('settings:set', { key, value });
      set({ values: snapshot });
    } catch (error) {
      set({ values: previous });
      throw error;
    }
  },
  async reset(key) {
    set({ values: await invoke('settings:reset', { key }) });
  },
}));
