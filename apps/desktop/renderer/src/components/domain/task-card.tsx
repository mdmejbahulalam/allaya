import { RotateCcw } from 'lucide-react';
import type { TaskState } from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';

export interface TaskSummary {
  id: string;
  title: string;
  state: TaskState;
  startedAt?: number;
  durationMs?: number;
  actionCount: number;
  filesChanged: number;
}

const tone = (state: TaskState) =>
  state === 'COMPLETED'
    ? 'success'
    : state === 'FAILED' || state === 'ERROR'
      ? 'danger'
      : state === 'PAUSED' || state === 'WAITING_FOR_USER'
        ? 'warning'
        : state === 'CANCELLED'
          ? 'neutral'
          : 'accent';

export function TaskStateBadge({ state }: { state: TaskState }) {
  const t = useT();
  return (
    <Badge tone={tone(state)} dot>
      {t.t(`taskState.${state}`)}
    </Badge>
  );
}

export function TaskCard({
  task,
  onOpen,
  onRetry,
}: {
  task: TaskSummary;
  onOpen?: (task: TaskSummary) => void;
  onRetry?: (task: TaskSummary) => void;
}) {
  const t = useT();
  const retryable = task.state === 'FAILED' || task.state === 'CANCELLED';
  return (
    <Card
      interactive={Boolean(onOpen)}
      onClick={onOpen ? () => onOpen(task) : undefined}
      className="flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 truncate text-h3 font-semibold text-fg">{task.title}</h3>
        <TaskStateBadge state={task.state} />
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-small text-muted">
        {task.startedAt !== undefined && (
          <div className="flex gap-1.5">
            <dt>{t.t('tasks.started')}</dt>
            <dd className="text-fg">{t.formatRelativeTime(task.startedAt)}</dd>
          </div>
        )}
        {task.durationMs !== undefined && (
          <div className="flex gap-1.5">
            <dt>{t.t('tasks.duration')}</dt>
            <dd className="text-fg tabular-nums">{t.formatDuration(task.durationMs)}</dd>
          </div>
        )}
        <div>{t.t('tasks.actions', { count: task.actionCount })}</div>
        {task.filesChanged > 0 && (
          <div>{t.t('tasks.filesChanged', { count: task.filesChanged })}</div>
        )}
      </dl>
      {(retryable || onOpen) && (
        <div className="flex gap-2">
          {retryable && onRetry && (
            <Button
              size="sm"
              variant="outline"
              leftIcon={<RotateCcw size={14} />}
              onClick={(event) => {
                event.stopPropagation();
                onRetry(task);
              }}
            >
              {t.t('common.retry')}
            </Button>
          )}
          {onOpen && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(task);
              }}
            >
              {t.t('common.details')}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
