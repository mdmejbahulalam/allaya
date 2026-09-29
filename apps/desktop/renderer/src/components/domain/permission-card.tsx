import type { ReactNode } from 'react';
import { PERMISSION_MODES, type PermissionMode, type PermissionSubject } from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Card } from '@renderer/components/ui/card';

/** Three-way segmented control: Always Allow / Ask Every Time / Never Allow. */
export function PermissionCard({
  subject,
  mode,
  onModeChange,
  description,
  icon,
  disabled,
}: {
  subject: PermissionSubject;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  const t = useT();
  const label = t.t(`permissions.subjects.${subject}`);
  return (
    <Card className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-[12rem] flex-1 items-center gap-3">
        {icon && (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-elevated text-accent-text">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h3 className="text-body font-semibold text-fg">{label}</h3>
          {description && <p className="text-small text-muted">{description}</p>}
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex shrink-0 gap-1 rounded-xl border border-line bg-bg-2 p-1"
      >
        {PERMISSION_MODES.map((option) => {
          const selected = option === mode;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onModeChange(option)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-small font-medium whitespace-nowrap transition-colors duration-150',
                selected
                  ? option === 'never'
                    ? 'bg-danger-solid text-white'
                    : option === 'always_allow'
                      ? 'bg-accent-solid text-accent-fg'
                      : 'bg-elevated text-fg'
                  : 'text-muted hover:text-fg',
                disabled && 'opacity-50',
              )}
            >
              {t.t(`permissions.modes.${option}`)}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
