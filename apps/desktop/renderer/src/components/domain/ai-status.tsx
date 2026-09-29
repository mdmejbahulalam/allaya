import { Check, Mic, Pause, ShieldCheck, Sparkles, TriangleAlert, Zap, Brain } from 'lucide-react';
import type { AgentStatus } from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';

const visuals: Record<
  AgentStatus,
  { icon: typeof Sparkles; ring: string; glyph: string; pulse: boolean }
> = {
  ready: {
    icon: Sparkles,
    ring: 'border-accent/40 bg-accent/10',
    glyph: 'text-accent-text',
    pulse: false,
  },
  listening: {
    icon: Mic,
    ring: 'border-accent-2/50 bg-accent-2/10',
    glyph: 'text-accent-2',
    pulse: true,
  },
  thinking: {
    icon: Brain,
    ring: 'border-accent/50 bg-accent/12',
    glyph: 'text-accent-text',
    pulse: true,
  },
  working: {
    icon: Zap,
    ring: 'border-accent/50 bg-accent/12',
    glyph: 'text-accent-text',
    pulse: true,
  },
  verifying: {
    icon: ShieldCheck,
    ring: 'border-accent-2/50 bg-accent-2/10',
    glyph: 'text-accent-2',
    pulse: true,
  },
  completed: {
    icon: Check,
    ring: 'border-success/50 bg-success/12',
    glyph: 'text-success',
    pulse: false,
  },
  failed: {
    icon: TriangleAlert,
    ring: 'border-danger/50 bg-danger/12',
    glyph: 'text-danger-text',
    pulse: false,
  },
  paused: {
    icon: Pause,
    ring: 'border-warning/50 bg-warning/12',
    glyph: 'text-warning',
    pulse: false,
  },
};

export function AIStatus({
  status,
  detail,
  variant = 'card',
  className,
}: {
  status: AgentStatus;
  /** Overrides the default description, e.g. "Opening Chrome". */
  detail?: string;
  variant?: 'card' | 'inline';
  className?: string;
}) {
  const t = useT();
  const { icon: Icon, ring, glyph, pulse } = visuals[status];
  const title = t.t(`status.${status}`);
  const description = detail ?? t.t(`status.${status}Desc`);

  const badge = (size: number, icon: number) => (
    <span
      aria-hidden
      className={cn('relative flex shrink-0 items-center justify-center rounded-full border', ring)}
      style={{ width: size, height: size }}
    >
      {pulse && (
        <span className={cn('absolute inset-0 rounded-full border animate-pulse-soft', ring)} />
      )}
      <Icon size={icon} className={glyph} />
    </span>
  );

  if (variant === 'inline') {
    return (
      <div role="status" aria-live="polite" className={cn('flex items-center gap-2.5', className)}>
        {badge(28, 15)}
        <span className="flex min-w-0 flex-col">
          <span className="text-small leading-tight font-medium text-fg">{title}</span>
          <span className="text-caption text-muted">{description}</span>
        </span>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex flex-col items-center gap-3 text-center', className)}
    >
      {badge(64, 28)}
      <div>
        <div className="text-h3 font-semibold text-fg">{title}</div>
        <div className="text-small text-muted">{description}</div>
      </div>
    </div>
  );
}
