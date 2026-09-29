import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@renderer/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-caption font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-elevated text-muted',
        accent: 'border-accent/30 bg-accent/12 text-accent-text',
        success: 'border-success/30 bg-success/12 text-success',
        warning: 'border-warning/30 bg-warning/12 text-warning',
        danger: 'border-danger/30 bg-danger/12 text-danger-text',
        info: 'border-accent-2/30 bg-accent-2/12 text-fg',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({ className, tone, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
