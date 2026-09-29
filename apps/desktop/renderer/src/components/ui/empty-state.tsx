import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

/** Every screen has a meaningful empty state (§103): what this is, and what to do next. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}
    >
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl border border-line bg-elevated text-accent-text">
        <Icon aria-hidden size={28} strokeWidth={1.6} />
      </div>
      <h2 className="text-h3 font-semibold text-fg">{title}</h2>
      {description && <p className="mt-1.5 max-w-sm text-body text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
