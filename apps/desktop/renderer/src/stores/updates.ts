import { create } from 'zustand';
import type { UpdateStatus } from '@allaya/validation';

interface UpdatesState {
  status: UpdateStatus | null;
  set: (status: UpdateStatus) => void;
}

export const useUpdatesStore = create<UpdatesState>((set) => ({
  status: null,
  set: (status) => set({ status }),
}));
