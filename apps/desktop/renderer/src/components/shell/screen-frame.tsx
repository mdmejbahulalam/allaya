import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

/** Standard page chrome: title row, optional actions, and a width-capped content column. */
export function ScreenFrame({
  title,
  description,
  actions,
  children,
  width = 'default',
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  width?: 'narrow' | 'default' | 'wide';
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-6 py-8 lg:px-8',
        width === 'narrow' && 'max-w-3xl',
        width === 'default' && 'max-w-5xl',
        width === 'wide' && 'max-w-7xl',
      )}
    >
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-h1 font-semibold text-fg">{title}</h1>
          {description && <p className="mt-1 text-body text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
