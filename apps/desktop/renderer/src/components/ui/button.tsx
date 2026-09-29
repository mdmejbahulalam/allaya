import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';
import { Spinner } from './spinner';

export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium select-none',
    'transition-[background-color,border-color,color,filter,transform] duration-150',
    'active:translate-y-px disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-accent-solid text-accent-fg hover:brightness-110',
        /** Reserved for the single most important call to action on a screen. */
        gradient: 'gradient-accent text-white hover:brightness-110',
        secondary:
          'border border-line bg-elevated text-fg hover:border-line-strong hover:brightness-110',
        outline: 'border border-line bg-transparent text-fg hover:bg-elevated',
        ghost: 'bg-transparent text-muted hover:bg-elevated hover:text-fg',
        danger: 'bg-danger-solid text-white hover:brightness-110',
      },
      size: {
        sm: 'h-8 px-3 text-small',
        md: 'h-10 px-4 text-body',
        lg: 'h-12 px-6 text-h3',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    loading,
    leftIcon,
    rightIcon,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? <Spinner size={16} /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
