import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { useT } from '@renderer/lib/i18n';
import { useRegisterOverlay } from '@renderer/stores/overlays';
import { cn } from '@renderer/lib/cn';
import { IconButton } from './icon-button';

/** Side sheet. Panel timing: 250ms. Slides from the inline-end edge (right in LTR). */
export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  width = 360,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  const t = useT();
  useRegisterOverlay(open);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.aside
                className={cn(
                  'fixed inset-y-0 end-0 z-40 flex max-w-full flex-col border-s border-line bg-bg-2 shadow-elevated',
                  className,
                )}
                style={{ width }}
                initial={{ x: 48, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 48, opacity: 0 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-line ps-4 pe-2">
                  <Dialog.Title className="text-h3 font-semibold text-fg">{title}</Dialog.Title>
                  <Dialog.Close asChild>
                    <IconButton label={t.t('a11y.closePanel')} icon={<X size={18} />} size="sm" />
                  </Dialog.Close>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
              </motion.aside>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
