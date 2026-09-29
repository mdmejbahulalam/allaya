import { Avatar as A } from 'radix-ui';
import { cn } from '@renderer/lib/cn';

export function Avatar({
  name,
  src,
  size = 32,
  className,
}: {
  name: string;
  src?: string;
  size?: number;
  className?: string;
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <A.Root
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {src && <A.Image src={src} alt="" className="size-full object-cover" />}
      <A.Fallback
        className="gradient-accent flex size-full items-center justify-center font-semibold text-white"
        style={{ fontSize: Math.max(11, size * 0.4) }}
        delayMs={src ? 300 : 0}
      >
        {initials || '·'}
      </A.Fallback>
    </A.Root>
  );
}
