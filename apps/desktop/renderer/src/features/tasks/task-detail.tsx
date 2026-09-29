import { ArrowLeft, Check, CirclePause, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { TaskDetail, TaskStepView } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { isFinished, useTasksStore } from '@renderer/stores/tasks';
import { TaskStateBadge } from '@renderer/components/domain/task-card';
import { Timeline, type TimelineStep } from '@renderer/components/domain/timeline';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { Progress } from '@renderer/components/ui/progress';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Textarea } from '@renderer/components/ui/input';
import { eventDetail, progressOf, timelineState, visibleEvents } from './task-utils';

const RISK_TONE = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'danger',
  CRITICAL: 'danger',
} as const;

function stepToTimeline(step: TaskStepView, t: ReturnType<typeof useT>): TimelineStep {
  const lines: string[] = [];
  if (step.detail) lines.push(step.detail);
  if (step.expected) lines.push(t.t('tasks.step.expected', { expected: step.expected }));
  if (step.toolHint) lines.push(t.t('tasks.step.tool', { tool: step.toolHint }));
  if (step.summary) lines.push(`${t.t('tasks.step.reported')}: ${step.summary}`);
  if (step.evidence) lines.push(`${t.t('tasks.step.checked')}:\n${step.evidence}`);
  if (step.error) lines.push(step.error);
  if (step.attempts > 1) lines.push(t.t('tasks.step.attempts', { count: step.attempts }));
  const duration =
    step.startedAt !== undefined && step.completedAt !== undefined
      ? Math.max(0, step.completedAt - step.startedAt)
      : undefined;
  return {
    id: step.id,
    title: step.title,
    state: timelineState(step.state),
    ...(lines.length > 0 ? { detail: lines.join('\n') } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(step.unverified
      ? { note: t.t('tasks.step.unverified'), noteTone: 'warning' as const }
      : step.optional
        ? { note: t.t('tasks.step.optional') }
        : {}),
  };
}

function useExplain() {
  const t = useT();
  return (error: unknown): string => {
    if (error instanceof IpcError && t.has(`errors.ipc.${error.code}`)) {
      return t.t(`errors.ipc.${error.code}` as TranslationKey);
    }
    return t.t('errors.ipc.UNKNOWN');
  };
}

export function TaskDetailPane({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT();
  const explain = useExplain();
  const summary = useTasksStore((s) => s.byId[id]);
  const select = useTasksStore((s) => s.select);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const updatedAt = summary?.updatedAt;

  // Reload when the task changes (the backend pushes a new summary for every change).
  useEffect(() => {
    let cancelled = false;
    invoke('tasks:get', { id }).then(
      (value) => {
        if (cancelled) return;
        setDetail(value);
        setMissing(false);
      },
      () => !cancelled && setMissing(true),
    );
    return () => {
      cancelled = true;
    };
  }, [id, updatedAt]);

  const shown = detail?.task.id === id ? detail : null;
  const task = summary ?? shown?.task;
  const steps = useMemo(
    () => (shown ? shown.steps.map((s) => stepToTimeline(s, t)) : []),
    [shown, t],
  );
  const events = useMemo(() => (shown ? visibleEvents(shown.events) : []), [shown]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(explain(error));
    } finally {
      setBusy(false);
    }
  };

  if (missing && !task) {
    return (
      <Card>
        <Button variant="ghost" size="sm" leftIcon={<ArrowLeft size={14} />} onClick={onBack}>
          {t.t('common.back')}
        </Button>
        <p className="mt-3 text-body text-muted">{t.t('errors.ipc.NOT_FOUND')}</p>
      </Card>
    );
  }
  if (!task || !shown) {
    return (
      <Card className="space-y-3" aria-busy="true">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  const finished = isFinished(task);
  const progress = progressOf(task);
  const { pending } = task;
  const assessment = shown.assessment;

  return (
    <div className="flex flex-col gap-4" data-testid="task-detail">
      <Card className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            leftIcon={<ArrowLeft size={14} />}
            onClick={onBack}
            aria-label={t.t('common.back')}
          />
          <h2 className="min-w-0 flex-1 text-h2 font-semibold break-words text-fg">{task.title}</h2>
          <TaskStateBadge state={task.state} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
          {task.running && <Badge tone="accent">{t.t('tasks.running')}</Badge>}
          {task.queued && <Badge tone="neutral">{t.t('tasks.queued')}</Badge>}
          {task.outcome === 'partial' && (
            <Badge tone="warning">{t.t('tasks.outcome.partial')}</Badge>
          )}
          <Badge tone={RISK_TONE[task.riskLevel]}>{t.t(`risk.${task.riskLevel}`)}</Badge>
          {task.modelLabel && <span>{task.modelLabel}</span>}
          {task.startedAt !== undefined && <span>{t.formatRelativeTime(task.startedAt)}</span>}
        </div>
        {!finished && progress !== undefined && (
          <div className="flex flex-col gap-1">
            <Progress
              value={progress}
              label={t.t('tasks.progress', { done: task.stepsDone, total: task.stepCount })}
            />
            <span className="text-caption text-muted">
              {t.t('tasks.progress', { done: task.stepsDone, total: task.stepCount })}
            </span>
          </div>
        )}
        <p className="max-h-28 overflow-auto text-small whitespace-pre-wrap text-muted">
          {shown.request}
        </p>
        <p className="text-caption text-muted">
          {t.t('tasks.usage', {
            turns: t.formatNumber(shown.usage.modelTurns),
            calls: t.formatNumber(shown.usage.toolCalls),
            time: t.formatDuration(shown.usage.elapsedMs),
          })}
        </p>
      </Card>

      {pending?.kind === 'plan_approval' && (
        <Card variant="elevated" className="flex flex-col gap-3 border-warning/40">
          <h3 className="text-h3 font-semibold text-fg">{t.t('tasks.plan.review')}</h3>
          <p className="text-body text-muted">{t.t('tasks.plan.body')}</p>
          {shown.plan && <p className="text-body text-fg">{shown.plan.summary}</p>}
          {assessment && (
            <ul className="flex list-disc flex-col gap-1 ps-5 text-small text-muted">
              <li>{t.t('tasks.plan.risk', { risk: t.t(`risk.${assessment.risk}`) })}</li>
              {assessment.tools.length > 0 && (
                <li>{t.t('tasks.plan.tools', { tools: assessment.tools.join(', ') })}</li>
              )}
              {assessment.reasons.map((reason) => (
                <li key={reason}>{t.t(`tasks.plan.why.${reason}`)}</li>
              ))}
            </ul>
          )}
          {shown.plan?.successCriteria && (
            <p className="text-small text-muted">
              {t.t('tasks.plan.criteria', { criteria: shown.plan.successCriteria })}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              leftIcon={<Check size={16} />}
              loading={busy}
              onClick={() => act(() => invoke('tasks:approve', { id }))}
            >
              {t.t('tasks.approve')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => act(() => invoke('tasks:reject', { id }))}
            >
              {t.t('tasks.reject')}
            </Button>
          </div>
        </Card>
      )}

      {pending?.kind === 'question' && (
        <Card variant="elevated" className="flex flex-col gap-3 border-warning/40">
          <h3 className="text-h3 font-semibold text-fg">{t.t('tasks.question.title')}</h3>
          <p className="text-body whitespace-pre-wrap text-fg">{pending.question}</p>
          <Textarea
            autoGrow
            rows={2}
            maxRows={5}
            value={answer}
            aria-label={t.t('tasks.question.placeholder')}
            placeholder={t.t('tasks.question.placeholder')}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div>
            <Button
              variant="primary"
              disabled={!answer.trim()}
              loading={busy}
              onClick={() =>
                act(async () => {
                  await invoke('tasks:answer', { id, text: answer.trim() });
                  setAnswer('');
                })
              }
            >
              {t.t('tasks.question.send')}
            </Button>
          </div>
        </Card>
      )}

      {pending?.kind === 'declined' && (
        <Card variant="elevated" className="flex flex-col gap-3 border-warning/40">
          <h3 className="text-h3 font-semibold text-fg">
            {t.t(pending.unanswered ? 'tasks.declined.unansweredTitle' : 'tasks.declined.title')}
          </h3>
          <p className="text-body text-muted">
            {t.t(pending.unanswered ? 'tasks.declined.unansweredBody' : 'tasks.declined.body', {
              summary: pending.summary,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              leftIcon={<Play size={16} />}
              loading={busy}
              onClick={() => act(() => invoke('tasks:resume', { id }))}
            >
              {t.t('tasks.declined.continue')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => act(() => invoke('tasks:cancel', { id }))}
            >
              {t.t('tasks.declined.stop')}
            </Button>
          </div>
        </Card>
      )}

      {task.state === 'PAUSED' && (
        <Card variant="elevated" className="flex flex-col gap-3 border-warning/40">
          <p className="text-body text-fg">
            {t.t(
              task.pauseReason === 'interrupted' ? 'tasks.paused.interrupted' : 'tasks.paused.user',
            )}
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              leftIcon={<Play size={16} />}
              loading={busy}
              onClick={() => act(() => invoke('tasks:resume', { id }))}
            >
              {t.t('common.resume')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => act(() => invoke('tasks:cancel', { id }))}
            >
              {t.t('common.stop')}
            </Button>
          </div>
        </Card>
      )}

      {task.resultSummary && (
        <Card className="flex flex-col gap-2">
          <h3 className="text-h3 font-semibold text-fg">
            {t.t(task.state === 'FAILED' ? 'tasks.whyStopped' : 'tasks.result')}
          </h3>
          <p className="text-body break-words whitespace-pre-wrap text-fg">{task.resultSummary}</p>
        </Card>
      )}

      {steps.length > 0 && (
        <Card className="flex flex-col gap-3">
          <h3 className="text-h3 font-semibold text-fg">{t.t('tasks.steps')}</h3>
          {shown.plan && <p className="text-small text-muted">{shown.plan.summary}</p>}
          <Timeline steps={steps} />
        </Card>
      )}

      {!finished && task.state !== 'PAUSED' && pending === undefined && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            leftIcon={<CirclePause size={16} />}
            disabled={busy}
            onClick={() => act(() => invoke('tasks:pause', { id }))}
          >
            {t.t('common.pause')}
          </Button>
          <Button
            variant="danger"
            leftIcon={<Square size={14} />}
            disabled={busy}
            onClick={() => act(() => invoke('tasks:cancel', { id }))}
          >
            {t.t('common.stop')}
          </Button>
        </div>
      )}

      {finished && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            leftIcon={<RotateCcw size={14} />}
            loading={busy}
            onClick={() =>
              act(async () => {
                const created = await invoke('tasks:create', { request: shown.request });
                select(created.id);
              })
            }
          >
            {t.t('tasks.runAgain')}
          </Button>
          <Button
            variant="ghost"
            leftIcon={<Trash2 size={14} />}
            disabled={busy}
            onClick={() =>
              act(async () => {
                await invoke('tasks:remove', { id });
                onBack();
              })
            }
          >
            {t.t('common.remove')}
          </Button>
        </div>
      )}

      {events.length > 0 && (
        <details className="rounded-card border border-line bg-card px-[var(--card-pad)] py-3">
          <summary className="cursor-pointer text-body font-medium text-fg">
            {t.t('tasks.activity')}
          </summary>
          <ol className="mt-3 flex flex-col gap-2">
            {events.map((event) => {
              const detailText = eventDetail(event);
              return (
                <li key={event.id} className="flex flex-wrap gap-x-3 text-small">
                  <span className="text-caption text-muted tabular-nums">
                    {t.formatTime(event.createdAt)}
                  </span>
                  <span className="text-fg">{t.t(`tasks.event.${event.type}`)}</span>
                  {detailText && (
                    <span className="min-w-0 break-words text-muted">{detailText}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </div>
  );
}
