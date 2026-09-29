import type { HTMLAttributes } from 'react';
import { cn } from '@renderer/lib/cn';

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line bg-elevated px-1.5 font-sans text-caption text-muted',
        className,
      )}
      {...props}
    />
  );
}
