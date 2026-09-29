import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `elevated` for the primary surfaces: AI command, computer preview, task execution. */
  variant?: 'default' | 'elevated' | 'flat';
  interactive?: boolean;
  padded?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant = 'default', interactive, padded = true, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-card border border-line',
        variant === 'default' && 'bg-card',
        variant === 'elevated' && 'bg-elevated shadow-elevated',
        variant === 'flat' && 'bg-bg-2',
        padded && 'p-[var(--card-pad)]',
        interactive &&
          'cursor-pointer transition-[border-color,background-color,transform] duration-200 hover:border-line-strong hover:bg-elevated',
        className,
      )}
      {...props}
    />
  );
});

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h3 className="text-h3 font-semibold text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-small text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between text-small text-muted">
        <span>{label}</span>
        {icon}
      </div>
      <div className="mt-2 text-h1 font-semibold text-fg">{value}</div>
      {hint && <div className="mt-1 text-caption text-muted">{hint}</div>}
    </Card>
  );
}
