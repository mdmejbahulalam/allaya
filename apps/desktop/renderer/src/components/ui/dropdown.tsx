import { Check, ChevronDown } from 'lucide-react';
import { Select } from 'radix-ui';
import { cn } from '@renderer/lib/cn';
import { getStyleNonce } from '@renderer/lib/nonce';

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Dropdown({
  options,
  value,
  onValueChange,
  label,
  placeholder,
  className,
  disabled,
  id,
}: {
  options: DropdownOption[];
  value: string | undefined;
  onValueChange: (value: string) => void;
  /** Accessible name. */
  label: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <Select.Trigger
        id={id}
        aria-label={label}
        className={cn(
          'inline-flex h-10 min-w-40 items-center justify-between gap-2 rounded-control border border-line bg-bg-2 px-3 text-body text-fg',
          'transition-[border-color,box-shadow] duration-150 hover:border-line-strong',
          'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50',
          'data-[placeholder]:text-muted',
          className,
        )}
      >
        <Select.Value placeholder={placeholder} />
        <Select.Icon>
          <ChevronDown aria-hidden size={16} className="text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={6}
          className="z-[70] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line bg-elevated shadow-elevated"
        >
          <Select.Viewport nonce={getStyleNonce()} className="max-h-72 p-1">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex cursor-pointer items-start gap-2 rounded-lg py-2 ps-8 pe-3 text-body text-fg outline-none select-none',
                  'data-[highlighted]:bg-card data-[disabled]:opacity-50',
                )}
              >
                <Select.ItemIndicator className="absolute start-2 top-2.5">
                  <Check aria-hidden size={14} className="text-accent-text" />
                </Select.ItemIndicator>
                <span className="flex flex-col">
                  <Select.ItemText>{option.label}</Select.ItemText>
                  {option.description && (
                    <span className="text-caption text-muted">{option.description}</span>
                  )}
                </span>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
