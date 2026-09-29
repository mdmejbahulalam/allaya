import { create } from 'zustand';
import type { ActionRecord, ConfirmationView } from '@allaya/validation';
import { invoke } from '@renderer/lib/api';

interface ToolsState {
  /** Questions waiting for the user, oldest first. */
  pending: ConfirmationView[];
  /**
   * Questions already answered or expired. A slow `load()` snapshot can arrive after the event that settled one of
   * them (or after a newer one was pushed), so it is merged with — never allowed to overwrite — what events told us.
   */
  settled: Record<string, true>;
  /** Live actions by reply (message id). Persisted actions arrive with the message itself. */
  live: Record<string, ActionRecord[]>;
  load: () => Promise<void>;
  addPending: (view: ConfirmationView) => void;
  resolvePending: (id: string) => void;
  applyActivity: (messageId: string, action: ActionRecord) => void;
  /** Sends the user's answer. Returns whether the backend still had that question open. */
  respond: (id: string, decision: 'approved' | 'rejected') => Promise<boolean>;
}

export const useToolsStore = create<ToolsState>((set) => ({
  pending: [],
  settled: {},
  live: {},

  async load() {
    try {
      const loaded = await invoke('tools:listPendingConfirmations');
      set((s) => {
        const known = new Set(s.pending.map((p) => p.id));
        const fresh = loaded.filter((p) => !known.has(p.id) && !s.settled[p.id]);
        return fresh.length === 0
          ? s
          : { pending: [...s.pending, ...fresh].sort((a, b) => a.createdAt - b.createdAt) };
      });
    } catch {
      /* the next event will fill it in */
    }
  },

  addPending: (view) =>
    set((s) =>
      s.settled[view.id] || s.pending.some((p) => p.id === view.id)
        ? s
        : { pending: [...s.pending, view] },
    ),

  resolvePending: (id) =>
    set((s) => ({
      settled: { ...s.settled, [id]: true },
      pending: s.pending.filter((p) => p.id !== id),
    })),

  applyActivity: (messageId, action) =>
    set((s) => {
      const list = s.live[messageId] ?? [];
      const index = list.findIndex((a) => a.callId === action.callId);
      const next =
        index === -1
          ? [...list, action]
          : list.map((a, i) => (i === index ? { ...a, ...action } : a));
      return { live: { ...s.live, [messageId]: next } };
    }),

  async respond(id, decision) {
    const { accepted } = await invoke('tools:respondConfirmation', { id, decision });
    // Whatever the answer, this question is no longer worth showing.
    set((s) => ({
      settled: { ...s.settled, [id]: true },
      pending: s.pending.filter((p) => p.id !== id),
    }));
    return accepted;
  },
}));
