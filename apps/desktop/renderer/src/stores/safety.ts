import { create } from 'zustand';

/**
 * Counters the backend's push events bump, so screens that show the record or the emergency-stop key know to look
 * again. (The events carry no data: the screens ask for what they need.)
 */
interface SafetyState {
  activityVersion: number;
  safetyVersion: number;
  bumpActivity: () => void;
  bumpSafety: () => void;
}

export const useSafetyStore = create<SafetyState>((set) => ({
  activityVersion: 0,
  safetyVersion: 0,
  bumpActivity: () => set((s) => ({ activityVersion: s.activityVersion + 1 })),
  bumpSafety: () => set((s) => ({ safetyVersion: s.safetyVersion + 1 })),
}));
