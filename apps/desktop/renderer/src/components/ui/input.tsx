import { X, Search } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@renderer/lib/cn';

const controlBase = cn(
  'w-full rounded-control border border-line bg-bg-2 text-fg placeholder:text-muted',
  'transition-[border-color,box-shadow] duration-150',
  'hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/25',
);

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  leftIcon?: ReactNode;
  rightSlot?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, leftIcon, rightSlot, ...props },
  ref,
) {
  return (
    <div className="relative flex items-center">
      {leftIcon && (
        <span aria-hidden className="pointer-events-none absolute start-3 text-muted">
          {leftIcon}
        </span>
      )}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          controlBase,
          'h-10 px-3 text-body',
          leftIcon && 'ps-10',
          rightSlot && 'pe-10',
          className,
        )}
        {...props}
      />
      {rightSlot && <span className="absolute end-2 flex items-center">{rightSlot}</span>}
    </div>
  );
});

export interface SearchInputProps extends Omit<
  InputProps,
  'leftIcon' | 'rightSlot' | 'type' | 'onChange' | 'value'
> {
  value: string;
  onValueChange: (value: string) => void;
  clearLabel: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onValueChange, clearLabel, ...props },
  ref,
) {
  return (
    <Input
      ref={ref}
      type="search"
      role="searchbox"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      leftIcon={<Search size={16} />}
      rightSlot={
        value ? (
          <button
            type="button"
            aria-label={clearLabel}
            onClick={() => onValueChange('')}
            className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-fg"
          >
            <X size={14} />
          </button>
        ) : undefined
      }
      {...props}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Grow with content up to `maxRows`. */
  autoGrow?: boolean;
  maxRows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, autoGrow, maxRows = 8, rows = 3, onChange, value, ...props },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  const resize = () => {
    const el = innerRef.current;
    if (!el || !autoGrow) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * maxRows + 16)}px`;
  };
  useLayoutEffect(resize, [value, autoGrow, maxRows]);
  useEffect(() => {
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  });

  return (
    <textarea
      ref={(node) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      aria-invalid={invalid || undefined}
      rows={rows}
      value={value}
      onChange={onChange}
      className={cn(controlBase, 'resize-none px-3 py-2 text-body', className)}
      {...props}
    />
  );
});

/** Label + control + hint/error wiring so assistive tech announces them together. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; 'aria-describedby'?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small font-medium text-fg">
        {label}
      </label>
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        invalid: Boolean(error),
      })}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-caption text-danger-text">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-caption text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
