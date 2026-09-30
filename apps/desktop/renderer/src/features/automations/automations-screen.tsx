import { Bot, History, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AutomationInput, AutomationRunView, AutomationView } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { toast } from '@renderer/stores/toasts';
import { useAutomationsStore } from '@renderer/stores/automations';
import { useTasksStore } from '@renderer/stores/tasks';
import { useUiStore } from '@renderer/stores/ui';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Switch } from '@renderer/components/ui/switch';
import { AutomationForm } from './automation-form';
import { emptyForm, formFrom, outline, whenText, type FormState } from './automation-utils';
import { countSteps } from './workflow-edit';

const STATUS_TONE = {
  running: 'accent',
  waiting_for_approval: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
} as const;

function useExplain() {
  const t = useT();
  return (error: unknown): string =>
    error instanceof IpcError && t.has(`errors.ipc.${error.code}`)
      ? t.t(`errors.ipc.${error.code}` as TranslationKey)
      : t.t('errors.ipc.UNKNOWN');
}

function RunHistory({ id, refreshKey }: { id: string; refreshKey: string }) {
  const t = useT();
  const [runs, setRuns] = useState<AutomationRunView[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke('automations:runs', { id, limit: 20 }).then(
      (list) => !cancelled && setRuns(list),
      () => !cancelled && setRuns([]),
    );
    return () => {
      cancelled = true;
    };
  }, [id, refreshKey]);

  if (runs === null) return <Skeleton className="h-10 w-full" />;
  if (runs.length === 0) {
    return <p className="text-small text-muted">{t.t('automations.historyEmpty')}</p>;
  }
  return (
    <ol className="flex flex-col gap-2">
      {runs.map((run) => (
        <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small">
          <Badge tone={STATUS_TONE[run.status]} dot>
            {t.t(`automations.status.${run.status}`)}
          </Badge>
          <span className="text-fg">
            {t.formatDate(run.startedAt, { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
          <span className="text-muted">{t.t(`automations.by.${run.triggeredBy}`)}</span>
          {run.progress && run.progress.steps > 0 && (
            <span className="text-muted">
              {t.t('automations.workflow.progress', {
                n: run.progress.steps,
                current: run.progress.current ?? '',
              })}
            </span>
          )}
          {run.note && <span className="text-muted">— {t.t(`automations.note.${run.note}`)}</span>}
          {run.error && <span className="min-w-0 break-words text-danger-text">{run.error}</span>}
          {run.taskId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                useTasksStore.getState().select(run.taskId ?? null);
                useUiStore.getState().navigate('tasks');
              }}
            >
              {t.t('tasks.openTask')}
            </Button>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A workflow run is waiting for the person to approve a step: what it asks, and the two answers. */
function ApprovalAsk({
  run,
  name,
  onDone,
}: {
  run: AutomationRunView;
  name: string;
  onDone: () => void;
}) {
  const t = useT();
  const explain = useExplain();
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await invoke('automations:decide', { runId: run.id, approve });
      toast.info(
        t.t(approve ? 'automations.workflow.approved' : 'automations.workflow.declined', { name }),
      );
      onDone();
    } catch (error) {
      toast.error(explain(error));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="group"
      aria-label={t.t('automations.workflow.approval.title')}
      className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/8 p-3"
      data-testid="approval-ask"
    >
      <p className="text-small font-medium text-fg">{t.t('automations.workflow.approval.title')}</p>
      <p className="text-body break-words text-fg">{run.approval?.message}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={() => void decide(true)}>
          {t.t('automations.workflow.approval.approve')}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide(false)}>
          {t.t('automations.workflow.approval.decline')}
        </Button>
      </div>
    </div>
  );
}

function AutomationCard({
  automation,
  onEdit,
  onDelete,
  onDecided,
}: {
  automation: AutomationView;
  onEdit: () => void;
  onDelete: () => void;
  onDecided: () => void;
}) {
  const t = useT();
  const explain = useExplain();
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  // The history reloads whenever the latest run changes.
  const refreshKey = `${automation.lastRun?.id ?? ''}:${automation.lastRun?.status ?? ''}:${automation.updatedAt}`;

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

  return (
    <Card className="flex flex-col gap-3" data-testid="automation-card">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-h3 font-semibold break-words text-fg">{automation.name}</h3>
          {automation.description && (
            <p className="mt-0.5 text-small text-muted">{automation.description}</p>
          )}
        </div>
        <Switch
          checked={automation.enabled}
          disabled={busy}
          label={t.t('automations.toggle', { name: automation.name })}
          onCheckedChange={(enabled) =>
            void act(() => invoke('automations:setEnabled', { id: automation.id, enabled }))
          }
        />
      </div>

      {automation.workflow ? (
        <details className="text-small">
          <summary className="cursor-pointer text-muted">
            <Badge tone="info">{t.t('automations.workflow.badge')}</Badge>{' '}
            {t.t('automations.workflow.stepCount', {
              count: countSteps(automation.workflow.steps),
            })}
          </summary>
          <ol className="mt-2 flex max-h-56 flex-col gap-0.5 overflow-auto text-muted">
            {outline(automation.workflow.steps, t).map((line, i) => (
              <li key={i} style={{ paddingInlineStart: `${line.depth * 1.25}rem` }}>
                {line.depth > 0 ? '↳ ' : ''}
                {line.text}
              </li>
            ))}
          </ol>
        </details>
      ) : (
        <p className="max-h-20 overflow-auto text-small whitespace-pre-wrap text-muted">
          {automation.instruction}
        </p>
      )}

      {automation.awaiting?.approval && (
        <ApprovalAsk run={automation.awaiting} name={automation.name} onDone={onDecided} />
      )}

      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-small">
        <div className="text-fg">{whenText(automation.trigger, t)}</div>
        {automation.enabled && automation.nextRunAt !== undefined && (
          <div className="text-muted">
            {t.t('automations.nextRun', {
              when: t.formatDate(automation.nextRunAt, { dateStyle: 'medium', timeStyle: 'short' }),
            })}
          </div>
        )}
        {automation.lastRun ? (
          <div className="flex items-center gap-1.5 text-muted">
            {t.t('automations.lastRun')}:
            <Badge tone={STATUS_TONE[automation.lastRun.status]} dot>
              {t.t(`automations.status.${automation.lastRun.status}`)}
            </Badge>
          </div>
        ) : (
          <div className="text-muted">{t.t('automations.neverRan')}</div>
        )}
      </dl>

      {automation.problem && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-small text-fg"
        >
          {t.t(`automations.problem.${automation.problem}`)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          leftIcon={<Play size={14} />}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await invoke('automations:runNow', { id: automation.id });
              toast.info(t.t('automations.started', { name: automation.name }));
            })
          }
        >
          {t.t('automations.runNow')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<History size={14} />}
          aria-expanded={showHistory}
          onClick={() => setShowHistory((s) => !s)}
        >
          {t.t('automations.history')}
        </Button>
        <span className="ms-auto flex gap-1">
          <IconButton label={t.t('common.edit')} icon={<Pencil size={16} />} onClick={onEdit} />
          <IconButton
            label={t.t('automations.delete')}
            icon={<Trash2 size={16} />}
            onClick={onDelete}
          />
        </span>
      </div>

      {showHistory && (
        <div className="border-t border-line pt-3">
          <RunHistory id={automation.id} refreshKey={refreshKey} />
        </div>
      )}
    </Card>
  );
}

export function AutomationsScreen() {
  const t = useT();
  const explain = useExplain();
  const overview = useAutomationsStore((s) => s.overview);
  const load = useAutomationsStore((s) => s.load);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState<{
    automation?: AutomationView;
    initial: FormState;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<AutomationView | null>(null);
  const [folders, setFolders] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => !cancelled && setFailed(true));
    invoke('files:overview').then(
      (files) =>
        !cancelled &&
        setFolders(files.roots.filter((root) => root.exists).map((root) => root.label)),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  const save = async (input: AutomationInput) => {
    setSaving(true);
    try {
      if (form?.automation) {
        await invoke('automations:update', { id: form.automation.id, changes: input });
      } else {
        await invoke('automations:create', input);
      }
      setForm(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const atLimit = overview !== null && overview.automations.length >= overview.limit;

  return (
    <ScreenFrame
      title={t.t('automations.title')}
      actions={
        <Button
          variant="primary"
          leftIcon={<Plus size={16} />}
          disabled={atLimit}
          onClick={() => setForm({ initial: emptyForm(Date.now()) })}
        >
          {t.t('automations.new')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {overview?.paused && (
          <Card
            variant="elevated"
            className="flex flex-wrap items-center justify-between gap-3 border-warning/40"
          >
            <div className="flex items-start gap-3">
              <Pause aria-hidden size={20} className="mt-0.5 shrink-0 text-warning" />
              <div>
                <p className="text-body font-medium text-fg">{t.t('automations.paused.title')}</p>
                <p className="text-small text-muted">{t.t('automations.paused.body')}</p>
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                void invoke('automations:setPaused', { paused: false })
                  .then(load)
                  .catch((error: unknown) => toast.error(explain(error)))
              }
            >
              {t.t('automations.paused.resume')}
            </Button>
          </Card>
        )}

        {atLimit && (
          <p className="text-small text-muted">
            {t.t('automations.limit', { count: overview.limit })}
          </p>
        )}

        {failed ? (
          <Card>
            <p className="text-body text-muted">{t.t('errors.ipc.UNKNOWN')}</p>
          </Card>
        ) : overview === null ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : overview.automations.length === 0 ? (
          <Card>
            <EmptyState
              icon={Bot}
              title={t.t('automations.emptyTitle')}
              description={t.t('automations.emptyBody')}
              action={
                <Button
                  variant="primary"
                  leftIcon={<Plus size={16} />}
                  onClick={() => setForm({ initial: emptyForm(Date.now()) })}
                >
                  {t.t('automations.create')}
                </Button>
              }
            />
          </Card>
        ) : (
          <ul aria-label={t.t('automations.list')} className={cn('flex flex-col gap-3')}>
            {overview.automations.map((automation) => (
              <li key={automation.id}>
                <AutomationCard
                  automation={automation}
                  onEdit={() => setForm({ automation, initial: formFrom(automation, Date.now()) })}
                  onDelete={() => setDeleting(automation)}
                  onDecided={() => void load()}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <AutomationForm
        initial={form?.initial ?? null}
        automation={form?.automation}
        folders={folders}
        busy={saving}
        onSubmit={save}
        onCancel={() => setForm(null)}
      />
      <ConfirmationDialog
        open={deleting !== null}
        risk="MEDIUM"
        message={t.t('automations.deleteBody', { name: deleting?.name ?? '' })}
        confirmLabel={t.t('common.delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (!target) return;
          void invoke('automations:delete', { id: target.id })
            .then(async () => {
              toast.success(t.t('automations.deleted', { name: target.name }));
              await load();
            })
            .catch((error: unknown) => toast.error(explain(error)));
        }}
      />
    </ScreenFrame>
  );
}
