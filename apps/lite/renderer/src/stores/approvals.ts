import { create } from 'zustand';
import type { ApprovalView } from '../../../shared/ipc';
import { invoke } from '../lib/api';

interface ApprovalsState {
  pending: ApprovalView[];
  load: () => Promise<void>;
  set: (pending: ApprovalView[]) => void;
  /** The person's answer. The question disappears at once; the engine confirms with the new list. */
  decide: (id: string, allow: boolean) => Promise<void>;
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  pending: [],
  async load() {
    set({ pending: await invoke('approvals:list') });
  },
  set: (pending) => set({ pending }),
  async decide(id, allow) {
    const before = get().pending;
    set({ pending: before.filter((a) => a.id !== id) });
    try {
      await invoke('approvals:decide', { id, allow });
    } catch (error) {
      set({ pending: before });
      throw error;
    }
  },
}));
