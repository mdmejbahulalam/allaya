import { create } from 'zustand';
import type { RouteId } from '@renderer/app/routes';

interface UiState {
  route: RouteId;
  navigate: (route: RouteId) => void;
  /** `null` = follow the responsive default for the current window size. */
  contextOpen: boolean | null;
  setContextOpen: (open: boolean | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Text staged for the composer (from quick actions / palette) before the user sends it. */
  composerDraft: string;
  setComposerDraft: (text: string) => void;
  /** Hover-expansion of an unpinned sidebar. */
  sidebarHover: boolean;
  setSidebarHover: (hover: boolean) => void;
}

function initialRoute(): RouteId {
  return typeof location !== 'undefined' && location.hash === '#/gallery' ? 'gallery' : 'home';
}

export const useUiStore = create<UiState>((set) => ({
  route: initialRoute(),
  navigate: (route) => set({ route }),
  contextOpen: null,
  setContextOpen: (contextOpen) => set({ contextOpen }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  composerDraft: '',
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  sidebarHover: false,
  setSidebarHover: (sidebarHover) => set({ sidebarHover }),
}));

if (typeof window !== 'undefined') {
  // The design-system gallery is addressable by hash (also used by visual tests).
  window.addEventListener('hashchange', () => {
    if (location.hash === '#/gallery') useUiStore.getState().navigate('gallery');
  });
}
