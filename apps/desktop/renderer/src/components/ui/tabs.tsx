import { Tabs as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

export function Tabs({
  items,
  value,
  onValueChange,
  label,
  children,
  className,
}: {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={className}>
      <T.List
        aria-label={label}
        className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-bg-2 p-1"
      >
        {items.map((item) => (
          <T.Trigger
            key={item.value}
            value={item.value}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-small font-medium whitespace-nowrap text-muted',
              'transition-colors duration-150 hover:text-fg',
              'data-[state=active]:bg-elevated data-[state=active]:text-fg data-[state=active]:shadow-sm',
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="rounded-pill bg-bg px-1.5 text-caption text-muted tabular-nums">
                {item.count}
              </span>
            )}
          </T.Trigger>
        ))}
      </T.List>
      {children}
    </T.Root>
  );
}

export const TabPanel = T.Content;
