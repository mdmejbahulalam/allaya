import type { Actor, ActivityResult } from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';

export interface ActivityEntry {
  id: string;
  timestamp: number;
  actor: Actor;
  text: string;
  result?: ActivityResult;
}

const dot: Record<ActivityResult, string> = {
  success: 'bg-success',
  failure: 'bg-danger',
  denied: 'bg-warning',
  cancelled: 'bg-line-strong',
  pending: 'bg-accent animate-pulse-soft',
  info: 'bg-accent-2',
};

export function ActivityItem({ entry, className }: { entry: ActivityEntry; className?: string }) {
  const t = useT();
  return (
    <li className={cn('flex gap-3', className)}>
      <span
        aria-hidden
        className={cn('mt-2 size-2 shrink-0 rounded-full', dot[entry.result ?? 'info'])}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-caption text-muted">
          <time dateTime={new Date(entry.timestamp).toISOString()} className="tabular-nums">
            {t.formatTime(entry.timestamp)}
          </time>
          <span aria-hidden>·</span>
          <span>{t.t(`activity.actors.${entry.actor}`)}</span>
        </div>
        <p className="text-body text-fg">{entry.text}</p>
      </div>
    </li>
  );
}
