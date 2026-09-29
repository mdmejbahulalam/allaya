import { ListChecks, Trash2, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TaskSummary } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { toast } from '@renderer/stores/toasts';
import {
  TASK_TABS,
  isFinished,
  matchesTab,
  sortTasks,
  useTasksStore,
  type TaskTab,
} from '@renderer/stores/tasks';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { TaskStateBadge } from '@renderer/components/domain/task-card';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { Textarea } from '@renderer/components/ui/input';
import { Progress } from '@renderer/components/ui/progress';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Switch } from '@renderer/components/ui/switch';
import { Tabs } from '@renderer/components/ui/tabs';
import { TaskDetailPane } from './task-detail';
import { progressOf } from './task-utils';

function Composer() {
  const t = useT();
  const select = useTasksStore((s) => s.select);
  const [text, setText] = useState('');
  const [planFirst, setPlanFirst] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    const request = text.trim();
    if (!request || busy) return;
    setBusy(true);
    try {
      const created = await invoke('tasks:create', { request, planFirst });
      setText('');
      select(created.id);
    } catch (error) {
      toast.error(
        error instanceof IpcError && t.has(`errors.ipc.${error.code}`)
          ? t.t(`errors.ipc.${error.code}` as TranslationKey)
          : t.t('errors.ipc.UNKNOWN'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="elevated" className="flex flex-col gap-3">
      <label htmlFor="task-new" className="text-small font-medium text-muted">
        {t.t('tasks.new.title')}
      </label>
      <Textarea
        id="task-new"
        autoGrow
        rows={2}
        maxRows={6}
        value={text}
        placeholder={t.t('tasks.new.placeholder')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter starts; Shift+Enter adds a line; never mid-IME composition (Bengali input).
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void start();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-small text-fg">
          <Switch
            checked={planFirst}
            onCheckedChange={setPlanFirst}
            label={t.t('tasks.new.planFirst')}
          />
          {t.t('tasks.new.planFirst')}
        </label>
        <Button
          variant="gradient"
          leftIcon={<Zap size={16} />}
          disabled={!text.trim()}
          loading={busy}
          onClick={() => void start()}
        >
          {t.t('tasks.new.start')}
        </Button>
      </div>
      <p className="text-caption text-muted">{t.t('tasks.new.hint')}</p>
    </Card>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: TaskSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const progress = progressOf(task);
  return (
    <li>
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={onSelect}
        className={cn(
          'flex w-full flex-col gap-2 rounded-card border bg-card p-4 text-start transition-colors',
          selected
            ? 'border-accent/60 bg-elevated'
            : 'border-line hover:border-line-strong hover:bg-elevated',
        )}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
            {task.title}
          </span>
          <TaskStateBadge state={task.state} />
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
          <span>{t.formatRelativeTime(task.createdAt)}</span>
          {task.stepCount > 0 && (
            <span>{t.t('tasks.progress', { done: task.stepsDone, total: task.stepCount })}</span>
          )}
          {task.queued && <span>{t.t('tasks.queued')}</span>}
          {task.outcome === 'partial' && (
            <Badge tone="warning">{t.t('tasks.outcome.partial')}</Badge>
          )}
        </span>
        {(task.running || task.queued) && progress !== undefined && (
          <Progress
            value={progress}
            label={t.t('tasks.progress', { done: task.stepsDone, total: task.stepCount })}
          />
        )}
      </button>
    </li>
  );
}

export function TasksScreen() {
  const t = useT();
  const byId = useTasksStore((s) => s.byId);
  const loaded = useTasksStore((s) => s.loaded);
  const selectedId = useTasksStore((s) => s.selectedId);
  const select = useTasksStore((s) => s.select);
  const [tab, setTab] = useState<TaskTab>('all');

  const tasks = useMemo(() => sortTasks(byId), [byId]);
  const shown = useMemo(() => tasks.filter((task) => matchesTab(task, tab)), [tasks, tab]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        TASK_TABS.map((k) => [k, tasks.filter((task) => matchesTab(task, k)).length]),
      ),
    [tasks],
  );
  const anyFinished = tasks.some(isFinished);

  const clearFinished = async () => {
    try {
      const { removed } = await invoke('tasks:clearFinished');
      toast.success(t.t('tasks.cleared', { count: removed }));
    } catch {
      toast.error(t.t('errors.ipc.UNKNOWN'));
    }
  };

  return (
    <ScreenFrame
      title={t.t('tasks.title')}
      width="wide"
      actions={
        anyFinished ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Trash2 size={14} />}
            onClick={() => void clearFinished()}
          >
            {t.t('tasks.clearFinished')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <Composer />
        {!loaded ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : tasks.length === 0 ? (
          <Card>
            <EmptyState
              icon={ListChecks}
              title={t.t('tasks.emptyTitle')}
              description={t.t('tasks.emptyBody')}
            />
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className={cn('flex min-w-0 flex-col gap-3', selectedId && 'hidden lg:flex')}>
              <Tabs
                label={t.t('tasks.filter')}
                value={tab}
                onValueChange={(value) => setTab(value as TaskTab)}
                items={TASK_TABS.map((value) => ({
                  value,
                  label: t.t(`tasks.tabs.${value}`),
                  count: counts[value] ?? 0,
                }))}
              />
              {shown.length === 0 ? (
                <p className="px-2 py-6 text-center text-body text-muted">
                  {t.t('tasks.listEmpty')}
                </p>
              ) : (
                <ul aria-label={t.t('tasks.list')} className="flex flex-col gap-2">
                  {shown.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      selected={task.id === selectedId}
                      onSelect={() => select(task.id)}
                    />
                  ))}
                </ul>
              )}
            </div>
            <div className={cn('min-w-0', !selectedId && 'hidden lg:block')}>
              {selectedId ? (
                <TaskDetailPane id={selectedId} onBack={() => select(null)} />
              ) : (
                <Card className="flex h-full min-h-40 items-center justify-center">
                  <p className="text-body text-muted">{t.t('tasks.selectHint')}</p>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>
    </ScreenFrame>
  );
}
