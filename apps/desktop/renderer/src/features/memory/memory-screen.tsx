import { Brain, Download, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MEMORY_CATEGORIES, type MemoryCategory } from '@allaya/types';
import type { MemoryInput, MemoryView } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { toast } from '@renderer/stores/toasts';
import { useMemoryStore } from '@renderer/stores/memory';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Input } from '@renderer/components/ui/input';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Switch } from '@renderer/components/ui/switch';
import { emptyMemoryForm, MemoryForm, memoryFormFrom, type MemoryFormState } from './memory-form';
import { fold } from './search';

function useExplain() {
  const t = useT();
  return (error: unknown): string =>
    error instanceof IpcError && t.has(`errors.ipc.${error.code}`)
      ? t.t(`errors.ipc.${error.code}` as TranslationKey)
      : t.t('errors.ipc.UNKNOWN');
}

function MemoryRow({
  memory,
  onEdit,
  onDelete,
}: {
  memory: MemoryView;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <Card className="flex items-start gap-3" data-testid="memory-item">
      <div className="min-w-0 flex-1">
        <h3 className="text-body font-semibold break-words text-fg">{memory.key}</h3>
        <p className="mt-0.5 text-body break-words whitespace-pre-wrap text-fg">{memory.value}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
          <Badge tone={memory.source === 'inferred' ? 'accent' : 'neutral'}>
            {t.t(`memory.by.${memory.source}`)}
          </Badge>
          <span>
            {memory.useCount > 0
              ? t.t('memory.usedCount', { count: memory.useCount })
              : t.t('memory.neverUsed')}
          </span>
          {memory.lastUsedAt !== undefined && (
            <span>
              {t.t('memory.lastUsed', {
                when: t.formatDate(memory.lastUsedAt, { dateStyle: 'medium', timeStyle: 'short' }),
              })}
            </span>
          )}
        </div>
      </div>
      <span className="flex gap-1">
        <IconButton label={t.t('common.edit')} icon={<Pencil size={16} />} onClick={onEdit} />
        <IconButton label={t.t('memory.forget')} icon={<Trash2 size={16} />} onClick={onDelete} />
      </span>
    </Card>
  );
}

export function MemoryScreen() {
  const t = useT();
  const explain = useExplain();
  const overview = useMemoryStore((s) => s.overview);
  const load = useMemoryStore((s) => s.load);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MemoryCategory | 'all'>('all');
  const [form, setForm] = useState<{ memory?: MemoryView; initial: MemoryFormState } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<MemoryView | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const shown = useMemo(() => {
    const needle = fold(query.trim());
    return (overview?.memories ?? []).filter(
      (m) =>
        (filter === 'all' || m.category === filter) &&
        (needle === '' || fold(`${m.key} ${m.value}`).includes(needle)),
    );
  }, [overview, query, filter]);

  const save = async (input: MemoryInput) => {
    setSaving(true);
    try {
      if (form?.memory) await invoke('memory:update', { id: form.memory.id, changes: input });
      else await invoke('memory:create', input);
      setForm(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const total = overview?.memories.length ?? 0;
  const atLimit = overview !== null && total >= overview.limit;
  const counts = useMemo(() => {
    const by = new Map<MemoryCategory, number>();
    for (const m of overview?.memories ?? []) by.set(m.category, (by.get(m.category) ?? 0) + 1);
    return by;
  }, [overview]);

  const exportAll = async () => {
    try {
      const { saved } = await invoke('memory:export');
      if (saved) toast.success(t.t('memory.exported', { count: total }));
    } catch {
      toast.error(t.t('memory.exportFailed'));
    }
  };

  return (
    <ScreenFrame
      title={t.t('memory.title')}
      actions={
        <Button
          variant="primary"
          leftIcon={<Plus size={16} />}
          disabled={atLimit}
          onClick={() =>
            setForm({ initial: emptyMemoryForm(filter === 'all' ? undefined : filter) })
          }
        >
          {t.t('memory.new')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Card variant="elevated" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-3 text-body font-medium text-fg">
              <Switch
                checked={overview?.enabled ?? true}
                disabled={overview === null}
                label={t.t('memory.toggle')}
                onCheckedChange={(enabled) =>
                  void invoke('memory:setEnabled', { enabled })
                    .then(load)
                    .catch((error: unknown) => toast.error(explain(error)))
                }
              />
              {t.t('memory.toggle')}
            </label>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Download size={14} />}
                disabled={total === 0}
                onClick={() => void exportAll()}
              >
                {t.t('memory.export')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Trash2 size={14} />}
                disabled={total === 0}
                onClick={() => setClearing(true)}
              >
                {t.t('memory.forgetAll')}
              </Button>
            </span>
          </div>
          {overview && !overview.enabled && (
            <div
              role="status"
              className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2"
            >
              <p className="text-small font-medium text-fg">{t.t('memory.off.title')}</p>
              <p className="text-small text-muted">{t.t('memory.off.body')}</p>
            </div>
          )}
          <div className="flex items-start gap-2 text-small text-muted">
            <ShieldCheck aria-hidden size={16} className="mt-0.5 shrink-0 text-success" />
            <p>
              <span className="font-medium text-fg">{t.t('memory.privacyTitle')}. </span>
              {t.t('memory.privacyBody')}
            </p>
          </div>
        </Card>

        {total > 0 && (
          <div className="flex flex-col gap-3">
            <Input
              type="search"
              aria-label={t.t('memory.search')}
              placeholder={t.t('memory.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.t('memory.title')}>
              {(['all', ...MEMORY_CATEGORIES] as const)
                .filter((c) => c === 'all' || counts.has(c))
                .map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={filter === c}
                    onClick={() => setFilter(c)}
                    className={cn(
                      'h-8 rounded-control border px-3 text-small font-medium transition-colors',
                      filter === c
                        ? 'border-accent bg-accent/15 text-accent-text'
                        : 'border-line text-muted hover:border-line-strong hover:text-fg',
                    )}
                  >
                    {c === 'all' ? t.t('memory.all') : t.t(`memory.categories.${c}`)}
                    {c !== 'all' && <span className="ms-1.5 opacity-70">{counts.get(c)}</span>}
                  </button>
                ))}
            </div>
            <p className="text-caption text-muted">
              {t.t('memory.count', { count: total, limit: overview?.limit ?? 0 })}
            </p>
          </div>
        )}

        {failed ? (
          <Card>
            <p className="text-body text-muted">{t.t('errors.ipc.UNKNOWN')}</p>
          </Card>
        ) : overview === null ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : total === 0 ? (
          <Card>
            <EmptyState
              icon={Brain}
              title={t.t('memory.emptyTitle')}
              description={t.t('memory.emptyBody')}
              action={
                <Button
                  variant="primary"
                  leftIcon={<Plus size={16} />}
                  onClick={() => setForm({ initial: emptyMemoryForm() })}
                >
                  {t.t('memory.new')}
                </Button>
              }
            />
          </Card>
        ) : shown.length === 0 ? (
          <p className="text-body text-muted">{t.t('memory.noMatch')}</p>
        ) : (
          <ul aria-label={t.t('memory.list')} className="flex flex-col gap-3">
            {shown.map((memory) => (
              <li key={memory.id}>
                <MemoryRow
                  memory={memory}
                  onEdit={() => setForm({ memory, initial: memoryFormFrom(memory) })}
                  onDelete={() => setDeleting(memory)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <MemoryForm
        initial={form?.initial ?? null}
        editing={form?.memory !== undefined}
        busy={saving}
        onSubmit={save}
        onCancel={() => setForm(null)}
      />
      <ConfirmationDialog
        open={deleting !== null}
        risk="MEDIUM"
        message={t.t('memory.forgetBody', { title: deleting?.key ?? '' })}
        confirmLabel={t.t('memory.forget')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (!target) return;
          void invoke('memory:delete', { id: target.id })
            .then(async () => {
              toast.success(t.t('memory.forgotten', { title: target.key }));
              await load();
            })
            .catch((error: unknown) => toast.error(explain(error)));
        }}
      />
      <ConfirmationDialog
        open={clearing}
        risk="HIGH"
        message={t.t('memory.forgetAllBody', { count: total })}
        confirmLabel={t.t('memory.forgetAll')}
        onCancel={() => setClearing(false)}
        onConfirm={() => {
          setClearing(false);
          void invoke('memory:deleteAll')
            .then(async () => {
              toast.success(t.t('memory.forgottenAll'));
              await load();
            })
            .catch((error: unknown) => toast.error(explain(error)));
        }}
      />
    </ScreenFrame>
  );
}
