import type { HTMLAttributes } from 'react';
import { cn } from '@renderer/lib/cn';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-shimmer rounded-control bg-[length:200%_100%]',
        'bg-[linear-gradient(90deg,var(--elevated)_25%,var(--line)_50%,var(--elevated)_75%)]',
        className,
      )}
      {...props}
    />
  );
}
