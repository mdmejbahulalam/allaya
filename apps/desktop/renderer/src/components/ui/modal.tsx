import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog } from 'radix-ui';
import type { ReactNode, RefObject } from 'react';
import { useT } from '@renderer/lib/i18n';
import { useRegisterOverlay } from '@renderer/stores/overlays';
import { cn } from '@renderer/lib/cn';
import { IconButton } from './icon-button';

const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' } as const;

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof sizes;
  /** Where focus lands when the modal opens. Defaults to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Blocks dismissal by overlay click (Escape still closes). Use for confirmations. */
  modalOnly?: boolean;
  icon?: ReactNode;
  className?: string;
}

/** Modal timing: 300ms ease-out, per the motion spec (300–500ms). */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  initialFocusRef,
  modalOnly,
  icon,
  className,
}: ModalProps) {
  const t = useT();
  useRegisterOverlay(open);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              />
            </Dialog.Overlay>
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <Dialog.Content
                asChild
                forceMount
                onOpenAutoFocus={(event) => {
                  if (initialFocusRef?.current) {
                    event.preventDefault();
                    initialFocusRef.current.focus();
                  }
                }}
                onInteractOutside={(event) => modalOnly && event.preventDefault()}
              >
                <motion.div
                  className={cn(
                    'flex max-h-[85vh] w-full flex-col rounded-card border border-line bg-elevated shadow-elevated',
                    sizes[size],
                    className,
                  )}
                  initial={{ opacity: 0, scale: 0.96, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, y: 4 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="flex items-start gap-3 p-6 pb-2">
                    {icon}
                    <div className="min-w-0 flex-1">
                      <Dialog.Title className="text-h2 font-semibold text-fg">{title}</Dialog.Title>
                      {description ? (
                        <Dialog.Description className="mt-1 text-body text-muted">
                          {description}
                        </Dialog.Description>
                      ) : (
                        <Dialog.Description className="sr-only">{title}</Dialog.Description>
                      )}
                    </div>
                    <Dialog.Close asChild>
                      <IconButton label={t.t('common.close')} icon={<X size={18} />} size="sm" />
                    </Dialog.Close>
                  </div>
                  {children && (
                    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">{children}</div>
                  )}
                  {footer && (
                    <div className="flex flex-wrap justify-end gap-2 p-6 pt-3">{footer}</div>
                  )}
                </motion.div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
