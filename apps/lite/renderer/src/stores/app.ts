import { create } from 'zustand';
import { settingsDefaults } from '../../../shared/defaults';
import type { Settings } from '../../../shared/ipc';
import { invoke } from '../lib/api';

export type Route = 'chat' | 'settings';
export type SettingsTab = 'providers' | 'general';

interface AppInfo {
  version: string;
  platform: string;
  locale: string;
  e2e: boolean;
}

interface AppState {
  info: AppInfo;
  settings: Settings;
  hydrated: boolean;
  route: Route;
  settingsTab: SettingsTab;
  load: () => Promise<void>;
  update: (changes: Partial<Settings>) => Promise<void>;
  go: (route: Route, tab?: SettingsTab) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  info: { version: '', platform: '', locale: 'en-US', e2e: false },
  settings: settingsDefaults,
  hydrated: false,
  route: 'chat',
  settingsTab: 'providers',
  async load() {
    const [info, settings] = await Promise.all([invoke('app:info'), invoke('settings:get')]);
    set({ info, settings, hydrated: true });
  },
  async update(changes) {
    const before = get().settings;
    set({ settings: { ...before, ...changes } });
    try {
      set({ settings: await invoke('settings:set', changes) });
    } catch (error) {
      set({ settings: before });
      throw error;
    }
  },
  go(route, tab) {
    set({ route, ...(tab ? { settingsTab: tab } : {}) });
  },
}));
