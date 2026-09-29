import { create } from 'zustand';
import type { AgentStatus } from '@allaya/types';
import type { ActivityEntry } from '@renderer/components/domain/activity-item';

const WORKING: readonly AgentStatus[] = ['thinking', 'working', 'verifying'];
const MAX_ACTIVITY = 100;

interface AgentState {
  status: AgentStatus;
  detail: string | undefined;
  activity: ActivityEntry[];
  isWorking: boolean;
  setStatus: (status: AgentStatus, detail?: string) => void;
  pushActivity: (entry: ActivityEntry) => void;
  clearActivity: () => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  status: 'ready',
  detail: undefined,
  activity: [],
  isWorking: false,
  setStatus: (status, detail) => set({ status, detail, isWorking: WORKING.includes(status) }),
  pushActivity: (entry) =>
    set((state) => ({
      activity: [entry, ...state.activity.filter((e) => e.id !== entry.id)].slice(0, MAX_ACTIVITY),
    })),
  clearActivity: () => set({ activity: [] }),
}));
