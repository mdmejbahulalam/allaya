import { Progress as P } from 'radix-ui';
import { cn } from '@renderer/lib/cn';

/** Determinate when `value` is given; otherwise an indeterminate shimmer. */
export function Progress({
  value,
  label,
  className,
}: {
  value?: number;
  label: string;
  className?: string;
}) {
  const indeterminate = value === undefined;
  return (
    <P.Root
      value={indeterminate ? null : value}
      aria-label={label}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-pill bg-elevated', className)}
    >
      <P.Indicator
        className={cn(
          'gradient-accent h-full rounded-pill transition-[width] duration-300 ease-out-soft',
          indeterminate && 'w-1/3 animate-pulse-soft',
        )}
        style={indeterminate ? undefined : { width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </P.Root>
  );
}
