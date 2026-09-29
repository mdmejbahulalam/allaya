import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import type { NotificationKind } from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { useToastStore, type ToastItem } from '@renderer/stores/toasts';

const visuals: Record<NotificationKind, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: 'text-success' },
  info: { icon: Info, className: 'text-accent-2' },
  working: { icon: LoaderCircle, className: 'text-accent-text animate-spin-slow' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  error: { icon: CircleAlert, className: 'text-danger-text' },
};

function ToastView({ toast }: { toast: ToastItem }) {
  const t = useT();
  const dismiss = useToastStore((s) => s.dismiss);
  const { icon: Icon, className } = visuals[toast.kind];

  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, dismiss]);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      // Errors interrupt assistive tech; everything else is announced politely.
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-[22rem] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-xl border border-line bg-elevated p-3.5 shadow-elevated"
    >
      <Icon aria-hidden size={20} className={cn('mt-0.5 shrink-0', className)} />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-fg">{toast.message}</p>
        {toast.description && <p className="mt-0.5 text-small text-muted">{toast.description}</p>}
        {toast.actionLabel && (
          <button
            type="button"
            onClick={() => {
              toast.onAction?.();
              dismiss(toast.id);
            }}
            className="mt-2 text-small font-medium text-accent-text hover:underline"
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={t.t('toast.dismiss')}
        onClick={() => dismiss(toast.id)}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-card hover:text-fg"
      >
        <X aria-hidden size={14} />
      </button>
    </motion.li>
  );
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <ol
      aria-label="Notifications"
      className="pointer-events-none fixed end-4 bottom-4 z-[80] flex flex-col items-end gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.map((item) => (
          <ToastView key={item.id} toast={item} />
        ))}
      </AnimatePresence>
    </ol>
  );
}
