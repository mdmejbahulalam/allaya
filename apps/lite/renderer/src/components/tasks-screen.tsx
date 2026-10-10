import {
  ArrowLeft,
  Ban,
  Check,
  CircleAlert,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { RunView, TaskView } from '../../../shared/ipc';
import { useT, type Translator } from '../i18n';
import { cn } from '../lib/cn';
import { Markdown } from '../lib/markdown';
import { describeSchedule } from '../lib/schedule-text';
import { formatWhen } from '../lib/time';
import { useAppStore } from '../stores/app';
import { findModel, useConnectionsStore } from '../stores/connections';
import { appName, useMcpStore } from '../stores/mcp';
import { useTasksStore } from '../stores/tasks';
import { StepLine } from './message';
import { TaskForm } from './task-form';
import { runErrorText, taskErrorText } from './task-errors';
import { Button } from './ui';

function statusOf(task: TaskView): 'running' | 'paused' | RunView['status'] | 'new' {
  if (task.running) return 'running';
  if (!task.enabled) return 'paused';
  return task.lastRun?.status ?? 'new';
}

function StatusIcon({ status }: { status: RunView['status'] }) {
  if (status === 'running') return <LoaderCircle size={14} className="animate-spin" aria-hidden />;
  if (status === 'done') return <Check size={14} className="text-success" aria-hidden />;
  if (status === 'cancelled') return <Ban size={14} aria-hidden />;
  return <CircleAlert size={14} className="text-danger" aria-hidden />;
}

/** The model a task uses, by name; or "Default model" when it follows the default. */
function useModelName(task: TaskView): string {
  const t = useT();
  const models = useConnectionsStore((s) => s.models);
  if (!task.model) return t.t('tasks.modelDefault');
  return findModel(models, task.model)?.displayName ?? task.model.modelId;
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-muted">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}

function nextText(t: Translator, task: TaskView): string | null {
  if (task.schedule.kind === 'manual') return null;
  if (!task.enabled) return null;
  if (task.nextRunAt === null) return t.t('tasks.noNext');
  return t.t('tasks.next', { when: formatWhen(task.nextRunAt, t.lang) });
}

/** "Run now", or "Stop" while it is going. A task still starting (its run not yet begun) can only wait. */
function RunControl({
  task,
  primary = false,
  onFailure,
}: {
  task: TaskView;
  primary?: boolean;
  onFailure: (text: string) => void;
}) {
  const t = useT();
  const { run, cancel } = useTasksStore();
  const act = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      onFailure(taskErrorText(t, error));
    }
  };
  const size = primary ? 'md' : 'sm';
  if (task.running && task.lastRun?.status === 'running') {
    const runId = task.lastRun.id;
    return (
      <Button size={size} onClick={() => void act(() => cancel(runId))}>
        <Square size={13} aria-hidden />
        {t.t('tasks.stop')}
      </Button>
    );
  }
  return (
    <Button
      size={size}
      variant={primary ? 'primary' : 'outline'}
      disabled={task.running}
      onClick={() => void act(() => run(task.id))}
    >
      <Play size={13} aria-hidden />
      {t.t('tasks.run')}
    </Button>
  );
}

function TaskCard({ task, onFailure }: { task: TaskView; onFailure: (text: string) => void }) {
  const t = useT();
  const show = useTasksStore((s) => s.show);
  const modelName = useModelName(task);
  const status = statusOf(task);
  const next = nextText(t, task);
  return (
    <li
      className="rounded-xl border border-line bg-panel p-4"
      data-testid="task"
      aria-label={task.title}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => show({ kind: 'detail', id: task.id })}
            className="max-w-full truncate text-start font-medium hover:underline"
            dir="auto"
          >
            {task.title}
          </button>
          <p className="mt-0.5 text-sm text-muted">
            {describeSchedule(t, task.schedule)} · {modelName}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5">
              {status !== 'new' && status !== 'paused' && <StatusIcon status={status} />}
              {t.t(`tasks.status.${status}`)}
              {task.lastRun && !task.running && (
                <span>· {formatWhen(task.lastRun.startedAt, t.lang)}</span>
              )}
            </span>
            {next && <span>· {next}</span>}
          </p>
        </div>
        <RunControl task={task} onFailure={onFailure} />
      </div>
    </li>
  );
}

function RunReport({ run }: { run: RunView }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-line p-4" data-testid="report">
      <p className="mb-3 flex flex-wrap items-center gap-x-2 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg">
          <StatusIcon status={run.status} />
          {t.t(`tasks.status.${run.status}`)}
        </span>
        <span>· {formatWhen(run.startedAt, t.lang)}</span>
        <span>· {t.t(`tasks.trigger.${run.trigger}`)}</span>
        {run.model && <span>· {run.model}</span>}
      </p>
      {run.steps.length > 0 && (
        <div className="mb-3 text-sm" aria-label={t.t('tasks.steps', { count: run.steps.length })}>
          {run.steps.map((step) => (
            <StepLine key={step.id} step={step} />
          ))}
        </div>
      )}
      {run.result ? (
        <div dir="auto" className="break-words">
          <Markdown text={run.result} />
        </div>
      ) : run.status === 'running' ? (
        <p className="text-sm text-muted">{t.t('tasks.working')}</p>
      ) : (
        !run.error && <p className="text-sm text-muted">{t.t('tasks.noReport')}</p>
      )}
      {run.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {runErrorText(t, run.error)}
        </p>
      )}
    </div>
  );
}

function TaskDetail({ task, onFailure }: { task: TaskView; onFailure: (text: string) => void }) {
  const t = useT();
  const { show, update, remove } = useTasksStore();
  const runs = useTasksStore((s) => s.runs);
  const modelName = useModelName(task);
  const servers = useMcpStore((s) => s.servers);
  const tools = [
    ...(task.groups.includes('browser') ? [t.t('tasks.tools.web')] : []),
    ...task.groups.flatMap((g) => appName(servers, g) ?? []),
  ];
  const [confirming, setConfirming] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = runs.find((r) => r.id === chosen) ?? runs[0];
  const status = statusOf(task);
  const next = nextText(t, task);
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      onFailure(taskErrorText(t, error));
    }
  };
  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          onClick={() => show({ kind: 'list' })}
          className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
        >
          <ArrowLeft size={14} aria-hidden />
          {t.t('tasks.back')}
        </button>
        <h2 className="text-xl font-semibold break-words" dir="auto">
          {task.title}
        </h2>
        <p className="mt-1 text-sm text-muted">
          <span className="inline-flex items-center gap-1.5">
            {status !== 'new' && status !== 'paused' && <StatusIcon status={status} />}
            {t.t(`tasks.status.${status}`)}
          </span>
          {task.createdBy === 'allaya' && <span> · {t.t('tasks.createdByAllaya')}</span>}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <RunControl task={task} primary onFailure={onFailure} />
        <Button onClick={() => show({ kind: 'form', id: task.id })}>
          <Pencil size={14} aria-hidden />
          {t.t('tasks.edit')}
        </Button>
        {confirming ? (
          <span className="inline-flex items-center gap-2 text-sm">
            {t.t('tasks.deleteConfirm', { title: task.title })}
            <Button size="sm" variant="danger" onClick={() => void act(() => remove(task.id))}>
              {t.t('tasks.deleteYes')}
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              {t.t('tasks.deleteKeep')}
            </Button>
          </span>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            <Trash2 size={14} aria-hidden />
            {t.t('tasks.delete')}
          </Button>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted">{t.t('tasks.form.when')}</dt>
        <dd>{describeSchedule(t, task.schedule)}</dd>
        <dt className="text-muted">{t.t('tasks.model')}</dt>
        <dd>{modelName}</dd>
        {next && (
          <>
            <dt className="text-muted">{t.t('tasks.nextLabel')}</dt>
            <dd>{next}</dd>
          </>
        )}
        <dt className="text-muted">{t.t('tasks.tools')}</dt>
        <dd>{tools.length > 0 ? tools.join(', ') : t.t('tasks.tools.none')}</dd>
      </dl>

      {task.schedule.kind !== 'manual' && (
        <Switch
          checked={task.enabled}
          label={t.t('tasks.enabled')}
          onChange={(enabled) => void act(() => update(task.id, { enabled }))}
        />
      )}

      <section aria-labelledby="task-instructions">
        <h3 id="task-instructions" className="mb-1.5 text-sm font-medium">
          {t.t('tasks.instructions')}
        </h3>
        <p
          dir="auto"
          className="rounded-xl border border-line bg-panel p-3 text-sm break-words whitespace-pre-wrap"
        >
          {task.instructions}
        </p>
      </section>

      <section aria-labelledby="task-runs">
        <h3 id="task-runs" className="mb-1.5 text-sm font-medium">
          {t.t('tasks.history')}
        </h3>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">{t.t('tasks.noRuns')}</p>
        ) : (
          <>
            <ul className="mb-3 flex flex-wrap gap-1.5">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-pressed={selected?.id === r.id}
                    onClick={() => setChosen(r.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm transition-colors',
                      selected?.id === r.id
                        ? 'border-accent bg-elevated'
                        : 'border-line-strong hover:bg-elevated',
                    )}
                  >
                    <StatusIcon status={r.status} />
                    {formatWhen(r.startedAt, t.lang)}
                  </button>
                </li>
              ))}
            </ul>
            {selected && <RunReport run={selected} />}
          </>
        )}
      </section>
    </div>
  );
}

/** Tasks: the list, one task with its reports, or the form to make or change one. */
export function TasksScreen() {
  const t = useT();
  const { tasks, loaded, view, show } = useTasksStore();
  const connections = useConnectionsStore((s) => s.connections);
  const go = useAppStore((s) => s.go);
  const [failure, setFailure] = useState<string | null>(null);
  const viewId = view.kind === 'list' ? null : view.id;
  const current = tasks.find((x) => x.id === viewId);

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        {failure && (
          <p
            role="alert"
            className="mb-4 flex items-center justify-between rounded-lg border border-line-strong px-3 py-2 text-sm text-danger"
          >
            {failure}
            <button
              type="button"
              aria-label={t.t('common.dismiss')}
              className="ms-3 text-muted"
              onClick={() => setFailure(null)}
            >
              ×
            </button>
          </p>
        )}
        {view.kind === 'form' ? (
          <TaskForm key={view.id ?? 'new'} task={current ?? null} />
        ) : view.kind === 'detail' && current ? (
          <TaskDetail key={current.id} task={current} onFailure={setFailure} />
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h1 className="text-2xl font-semibold">{t.t('tasks.title')}</h1>
              <Button variant="primary" onClick={() => show({ kind: 'form', id: null })}>
                <Plus size={16} aria-hidden />
                {t.t('tasks.new')}
              </Button>
            </div>
            <p className="mb-6 text-sm text-muted">{t.t('tasks.intro')}</p>
            {!loaded ? null : tasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line-strong p-6 text-center">
                <p className="font-medium">{t.t('tasks.none')}</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted">{t.t('tasks.noneHint')}</p>
                {connections.length === 0 && (
                  <button
                    type="button"
                    className="mt-3 text-sm text-accent underline underline-offset-2"
                    onClick={() => go('settings', 'providers')}
                  >
                    {t.t('chat.connect')}
                  </button>
                )}
              </div>
            ) : (
              <ul className="space-y-3">
                {tasks.map((task) => (
                  <TaskCard key={task.id} task={task} onFailure={setFailure} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
