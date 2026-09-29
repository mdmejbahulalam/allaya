import { create } from 'zustand';
import type { AppInfo } from '@allaya/validation';

interface AppInfoState extends Partial<AppInfo> {
  osLocale: string;
  loaded: boolean;
  set: (info: AppInfo) => void;
}

export const useAppInfoStore = create<AppInfoState>((set) => ({
  osLocale: typeof navigator === 'undefined' ? 'en-US' : navigator.language,
  loaded: false,
  set: (info) => set({ ...info, loaded: true }),
}));
