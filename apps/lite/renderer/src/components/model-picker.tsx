import { ChevronDown, RefreshCw, Search } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import type { ModelRef } from '../../../shared/ipc';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { findModel, sameModel, useConnectionsStore } from '../stores/connections';
import { useDismiss } from './ui';

const SHOWN_LIMIT = 80;

/**
 * The model of this chat. A button that says which, and a list of every model of every connected service, with a
 * search box (a service like OpenRouter lists hundreds).
 */
export function ModelPicker({
  value,
  onPick,
  onConnect,
  align = 'start',
  openUp = false,
}: {
  value: ModelRef | null;
  onPick: (model: ModelRef) => void;
  onConnect: () => void;
  align?: 'start' | 'end';
  openUp?: boolean;
}) {
  const t = useT();
  const models = useConnectionsStore((s) => s.models);
  const problems = useConnectionsStore((s) => s.problems);
  const loading = useConnectionsStore((s) => s.modelsLoading);
  const loadModels = useConnectionsStore((s) => s.loadModels);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  useDismiss(root, open, () => setOpen(false));

  const current = findModel(models, value);
  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const filtered = models.filter(
      (m) =>
        !needle ||
        m.displayName.toLowerCase().includes(needle) ||
        m.modelId.toLowerCase().includes(needle) ||
        m.connectionName.toLowerCase().includes(needle),
    );
    const shown = filtered.slice(0, SHOWN_LIMIT);
    const byConnection = new Map<string, typeof shown>();
    for (const m of shown)
      byConnection.set(m.connectionId, [...(byConnection.get(m.connectionId) ?? []), m]);
    return { list: [...byConnection.values()], total: filtered.length, shown: shown.length };
  }, [models, needle]);

  const label = current?.displayName ?? value?.modelId ?? t.t('model.choose');

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t.t('model.current', { name: label })}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex max-w-72 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-elevated hover:text-fg"
      >
        <span className="truncate">{label}</span>
        {current && (
          <span className="hidden truncate text-muted/70 sm:inline">
            · {current.connectionName}
          </span>
        )}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div
          className={cn(
            'absolute z-20 w-[22rem] max-w-[90vw] rounded-xl border border-line-strong bg-panel shadow-xl',
            align === 'end' ? 'end-0' : 'start-0',
            openUp ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search size={14} aria-hidden className="text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.t('model.search')}
              aria-label={t.t('model.search')}
              className="h-10 min-w-0 flex-1 bg-transparent outline-none focus-visible:outline-none placeholder:text-muted/70"
            />
            <button
              type="button"
              aria-label={t.t('model.refresh')}
              title={t.t('model.refresh')}
              disabled={loading}
              onClick={() => void loadModels(true)}
              className="rounded p-1 text-muted hover:bg-elevated hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
            </button>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={t.t('model.pick')}
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {models.length === 0 ? (
              <div className="px-3 py-4 text-sm">
                <p className="font-medium">{t.t('model.none')}</p>
                <p className="mt-0.5 text-muted">{t.t('model.noneHint')}</p>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onConnect();
                  }}
                  className="mt-2 text-accent underline underline-offset-2"
                >
                  {t.t('chat.connect')}
                </button>
              </div>
            ) : groups.total === 0 ? (
              <p className="px-3 py-4 text-sm text-muted">{t.t('model.noMatch', { query })}</p>
            ) : (
              groups.list.map((group) => (
                <div
                  key={group[0]!.connectionId}
                  role="group"
                  aria-label={group[0]!.connectionName}
                >
                  <p className="px-2.5 pt-2 pb-1 text-xs font-medium tracking-wide text-muted uppercase">
                    {group[0]!.connectionName}
                  </p>
                  {group.map((m) => {
                    const selected = sameModel(m, value);
                    return (
                      <button
                        key={`${m.connectionId}:${m.modelId}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        title={m.inferred ? t.t('model.inferred') : undefined}
                        onClick={() => {
                          onPick({ connectionId: m.connectionId, modelId: m.modelId });
                          setOpen(false);
                          setQuery('');
                        }}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-start text-sm hover:bg-elevated',
                          selected && 'bg-elevated',
                        )}
                      >
                        <span className="truncate">{m.displayName}</span>
                        {selected && (
                          <span aria-hidden className="text-accent">
                            ●
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
            {groups.total > groups.shown && (
              <p className="px-3 py-2 text-xs text-muted">
                {groups.shown} / {groups.total} — {t.t('model.search').toLowerCase()}
              </p>
            )}
            {problems.map((p) => (
              <p key={p.connectionId} role="status" className="px-3 py-1.5 text-xs text-danger">
                {t.t('model.problem', { name: p.connectionName, message: p.message })}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
