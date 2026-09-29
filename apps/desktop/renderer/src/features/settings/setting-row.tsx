import type { ReactNode } from 'react';

export function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-line py-4 first:pt-0 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-body font-medium text-fg">
          {label}
        </label>
        {description && <p className="mt-0.5 text-small text-muted">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}
