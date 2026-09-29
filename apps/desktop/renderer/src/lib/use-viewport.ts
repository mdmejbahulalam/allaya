import { useSyncExternalStore } from 'react';

/**
 * Window-width tiers (§68). Layout decisions key off these, never off pixel values sprinkled around:
 *  xl ≥1600  sidebar + main + full context panel      (1920×1080)
 *  lg ≥1280  sidebar + main + compact context panel   (1440×900, 1280×720)
 *  md ≥1100  collapsible context panel as a drawer
 *  sm <1100  collapsed sidebar + context drawer
 */
export type ViewportTier = 'xl' | 'lg' | 'md' | 'sm';

export function tierForWidth(width: number): ViewportTier {
  if (width >= 1600) return 'xl';
  if (width >= 1280) return 'lg';
  if (width >= 1100) return 'md';
  return 'sm';
}

function subscribe(callback: () => void) {
  window.addEventListener('resize', callback);
  return () => window.removeEventListener('resize', callback);
}

export function useViewportTier(): ViewportTier {
  return useSyncExternalStore(
    subscribe,
    () => tierForWidth(window.innerWidth),
    () => 'lg',
  );
}
