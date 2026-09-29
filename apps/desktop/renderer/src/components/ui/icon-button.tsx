import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';
import { Tooltip } from './tooltip';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  /** Required: names the control for screen readers and the tooltip. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  hideTooltip?: boolean;
}

const sizes = { sm: 'size-8', md: 'size-10', lg: 'size-12' } as const;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    size = 'md',
    active,
    className,
    tooltipSide,
    hideTooltip,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <Tooltip label={label} side={tooltipSide ?? 'bottom'} disabled={hideTooltip}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-control text-muted',
          'transition-colors duration-150 hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-50',
          active && 'bg-elevated text-fg',
          sizes[size],
          className,
        )}
        {...props}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
