import { Switch as S } from 'radix-ui';
import { cn } from '@renderer/lib/cn';

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <S.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-pill border border-line transition-colors duration-200',
        'data-[state=checked]:border-transparent data-[state=checked]:bg-accent-solid data-[state=unchecked]:bg-elevated',
        'disabled:opacity-50',
      )}
    >
      <S.Thumb className="block size-[18px] translate-x-[3px] rounded-full bg-white shadow transition-transform duration-200 ease-out-soft data-[state=checked]:translate-x-[22px]" />
    </S.Root>
  );
}
