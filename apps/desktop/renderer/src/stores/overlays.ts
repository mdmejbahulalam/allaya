import { useEffect } from 'react';
import { create } from 'zustand';

interface OverlayState {
  /** Number of modal layers (dialogs, drawers, palette) currently open. */
  depth: number;
  /** Increments each time a layer opens; lets tooltips discard "open" state from before it. */
  epoch: number;
  push: () => void;
  pop: () => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  depth: 0,
  epoch: 0,
  push: () => set((s) => ({ depth: s.depth + 1, epoch: s.epoch + 1 })),
  pop: () => set((s) => ({ depth: Math.max(0, s.depth - 1) })),
}));

/** Register a modal layer while `open`. Tooltips underneath are suppressed so they never absorb Escape. */
export function useRegisterOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const { push, pop } = useOverlayStore.getState();
    push();
    return pop;
  }, [open]);
}
