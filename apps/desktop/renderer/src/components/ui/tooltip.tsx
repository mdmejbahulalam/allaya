import { Tooltip as T } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { useOverlayStore } from '@renderer/stores/overlays';
import { cn } from '@renderer/lib/cn';

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <T.Provider delayDuration={350} skipDelayDuration={200}>
    {children}
  </T.Provider>
);

export function Tooltip({
  label,
  children,
  side = 'top',
  disabled,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  disabled?: boolean;
}) {
  const overlayOpen = useOverlayStore((state) => state.depth > 0);
  const epoch = useOverlayStore((state) => state.epoch);
  const [state, setState] = useState({ open: false, epoch });
  // A tooltip is its own dismissable layer: left open beneath a dialog it would swallow the first
  // Escape. Open-state recorded before the current overlay opened is discarded (epoch mismatch), so the
  // tooltip can't reappear when the overlay closes — and the trigger is never remounted, which keeps
  // Radix's focus restoration intact.
  const open = state.open && state.epoch === epoch && !overlayOpen;
  if (disabled) return <>{children}</>;
  return (
    <T.Root open={open} onOpenChange={(next) => setState({ open: next, epoch })}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={8}
          className={cn(
            'z-[60] rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-caption text-fg shadow-elevated',
            'data-[state=delayed-open]:animate-in',
          )}
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
