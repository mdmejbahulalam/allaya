import {
  Bell,
  Bot,
  Clock,
  FolderCog,
  Globe,
  Hourglass,
  MonitorCog,
  Play,
  Repeat,
  ShieldQuestion,
  Split,
  Flag,
  AppWindow,
  type LucideIcon,
} from 'lucide-react';
import type { AutomationNodeKind } from '@allaya/types';
import { cn } from '@renderer/lib/cn';

export const nodeVisuals: Record<AutomationNodeKind, { icon: LucideIcon; tone: string }> = {
  trigger: { icon: Play, tone: 'text-success bg-success/12 border-success/30' },
  ai: { icon: Bot, tone: 'text-accent-text bg-accent/12 border-accent/30' },
  computer: { icon: MonitorCog, tone: 'text-accent-2 bg-accent-2/12 border-accent-2/30' },
  browser: { icon: Globe, tone: 'text-accent-2 bg-accent-2/12 border-accent-2/30' },
  files: { icon: FolderCog, tone: 'text-warning bg-warning/12 border-warning/30' },
  applications: { icon: AppWindow, tone: 'text-accent-text bg-accent/12 border-accent/30' },
  condition: { icon: Split, tone: 'text-fg bg-elevated border-line-strong' },
  loop: { icon: Repeat, tone: 'text-fg bg-elevated border-line-strong' },
  wait: { icon: Hourglass, tone: 'text-muted bg-elevated border-line' },
  notification: { icon: Bell, tone: 'text-accent-text bg-accent/12 border-accent/30' },
  human_approval: { icon: ShieldQuestion, tone: 'text-warning bg-warning/12 border-warning/30' },
  end: { icon: Flag, tone: 'text-muted bg-elevated border-line' },
};

export { Clock as ScheduleIcon };

/** Presentational node used by the workflow canvas. Ports are drawn by the canvas layer. */
export function AutomationNode({
  kind,
  label,
  subtitle,
  selected,
  status,
}: {
  kind: AutomationNodeKind;
  label: string;
  subtitle?: string;
  selected?: boolean;
  status?: 'idle' | 'running' | 'done' | 'failed';
}) {
  const { icon: Icon, tone } = nodeVisuals[kind];
  return (
    <div
      className={cn(
        'flex w-56 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-[border-color,box-shadow] duration-150',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-line-strong',
        status === 'running' && 'border-accent',
        status === 'failed' && 'border-danger',
      )}
    >
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border', tone)}
      >
        <Icon aria-hidden size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-fg">{label}</span>
        {subtitle && <span className="block truncate text-caption text-muted">{subtitle}</span>}
      </span>
      {status === 'running' && (
        <span aria-hidden className="size-2 rounded-full bg-accent animate-pulse-soft" />
      )}
      {status === 'done' && <span aria-hidden className="size-2 rounded-full bg-success" />}
    </div>
  );
}
