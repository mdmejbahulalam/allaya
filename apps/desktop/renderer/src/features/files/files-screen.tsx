import {
  ArrowUp,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  HardDrive,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldOff,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  FileActionView,
  FileEntryView,
  FileListing,
  FileOutcome,
  FilesOverview,
} from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke, subscribe } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { toast } from '@renderer/stores/toasts';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card, CardHeader } from '@renderer/components/ui/card';
import { DataTable, type Column } from '@renderer/components/ui/data-table';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { IconButton } from '@renderer/components/ui/icon-button';
import { SearchInput } from '@renderer/components/ui/input';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Switch } from '@renderer/components/ui/switch';
import { NameDialog } from './name-dialog';

interface FolderState {
  path: string;
  showHidden: boolean;
  listing?: FileListing;
  error?: string;
}

/** One row: something in the current folder, or a search hit (which also knows where it lives). */
interface Row {
  key: string;
  name: string;
  kind: FileEntryView['kind'];
  size: number;
  modifiedAt: number;
  /** Folder-relative path to act on (`Documents/Reports/a.txt`). */
  path: string;
  /** Where a search hit lives; empty in a folder listing. */
  where: string;
}

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

function kindIcon(kind: Row['kind']) {
  if (kind === 'directory') return <Folder aria-hidden size={18} className="text-accent-text" />;
  if (kind === 'link') return <Link2 aria-hidden size={18} className="text-muted" />;
  if (kind === 'file') return <FileText aria-hidden size={18} className="text-muted" />;
  return <FileIcon aria-hidden size={18} className="text-muted" />;
}

export function FilesScreen() {
  const t = useT();
  const [overview, setOverview] = useState<FilesOverview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  // The folder the user chose; until they choose one, the first folder that exists.
  const [picked, setPicked] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderState | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [hits, setHits] = useState<{ rows: Row[]; cutShort: boolean; query: string } | null>(null);
  const [dialog, setDialog] = useState<
    { type: 'new-folder' } | { type: 'rename'; row: Row } | null
  >(null);
  const [busy, setBusy] = useState(false);
  /** Bumped whenever something may have changed on disk or in the journal: everything shown reloads. */
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const current = picked ?? overview?.roots.find((root) => root.exists)?.label ?? null;
  const setCurrent = setPicked;

  /** A refusal in the user's language, the generic message for the error code otherwise. */
  const explain = useCallback(
    (error: unknown): string => {
      if (error instanceof IpcError) {
        const reason = error.details?.['reason'];
        if (typeof reason === 'string' && t.has(`files.refusal.${reason}`)) {
          return t.t(`files.refusal.${reason}` as TranslationKey);
        }
        if (t.has(`errors.ipc.${error.code}`)) {
          return t.t(`errors.ipc.${error.code}` as TranslationKey);
        }
      }
      return t.t('errors.ipc.UNKNOWN');
    },
    [t],
  );

  useEffect(() => subscribe('files:changed', refresh), [refresh]);

  useEffect(() => {
    let cancelled = false;
    invoke('files:overview').then(
      (value) => !cancelled && setOverview(value),
      () => !cancelled && setOverviewFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    if (current === null) return;
    let cancelled = false; // an answer for a folder the user already left must not replace the current one
    invoke('files:list', { path: current, showHidden }).then(
      (listing) => !cancelled && setFolder({ path: current, showHidden, listing }),
      (error) => !cancelled && setFolder({ path: current, showHidden, error: explain(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [current, showHidden, tick, explain]);

  // Search as the user types, after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debounced) return;
    let cancelled = false;
    invoke('files:search', { query: debounced }).then(
      (result) =>
        !cancelled &&
        setHits({
          query: debounced,
          cutShort: result.truncated,
          rows: result.hits.map((hit) => ({
            key: hit.path,
            name: hit.name,
            kind: hit.kind,
            size: hit.size,
            modifiedAt: hit.modifiedAt,
            path: hit.path,
            where: parentOf(hit.path),
          })),
        }),
      (error) => !cancelled && toast.error(explain(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [debounced, tick, explain]);

  const here =
    folder && folder.path === current && folder.showHidden === showHidden ? folder : null;
  const listing = here?.listing ?? null;
  const errorText = here?.error ?? '';
  const state: 'idle' | 'loading' | 'error' = here ? (here.error ? 'error' : 'idle') : 'loading';
  const term = query.trim();
  const searchHits = hits && hits.query === term ? hits : null;

  const handleOutcome = useCallback(
    (outcome: FileOutcome) => {
      if (outcome.ok) {
        toast.success(t.t('files.outcome.done', { summary: outcome.summary }));
      } else if (outcome.status === 'rejected') {
        toast.info(t.t('files.outcome.rejected'));
      } else if (outcome.status === 'denied') {
        toast.warning(t.t('files.outcome.denied'));
      } else if (outcome.status === 'cancelled') {
        toast.info(t.t('files.outcome.cancelled'));
      } else {
        const reason = outcome.reason;
        toast.error(
          reason && t.has(`files.refusal.${reason}`)
            ? t.t(`files.refusal.${reason}` as TranslationKey)
            : t.t('files.outcome.failed'),
        );
      }
    },
    [t],
  );

  /** Every change goes through the permission and confirmation pipeline in the main process. */
  const change = useCallback(
    async (run: () => Promise<FileOutcome>) => {
      setBusy(true);
      try {
        handleOutcome(await run());
      } catch (error) {
        toast.error(explain(error));
      } finally {
        setBusy(false);
        setDialog(null);
        refresh();
      }
    },
    [handleOutcome, explain, refresh],
  );

  const open = async (row: Row) => {
    try {
      await invoke('files:open', { path: row.path });
      toast.success(t.t('files.opened', { name: row.name }));
    } catch (error) {
      toast.error(explain(error));
    }
  };

  const reveal = async (row: Row) => {
    try {
      await invoke('files:reveal', { path: row.path });
    } catch (error) {
      toast.error(explain(error));
    }
  };

  const addFolder = async () => {
    try {
      const result = await invoke('files:addFolder');
      if (result.added) {
        toast.success(t.t('files.added', { name: result.added.label }));
        setCurrent(result.added.label);
        refresh();
      }
    } catch (error) {
      toast.error(explain(error));
    }
  };

  const removeFolder = async (id: string, label: string) => {
    try {
      await invoke('files:removeFolder', { id });
      toast.success(t.t('files.removed', { name: label }));
      if (current === label || current?.startsWith(`${label}/`)) setPicked(null);
      refresh();
    } catch (error) {
      toast.error(explain(error));
    }
  };

  const rows: Row[] = useMemo(
    () =>
      listing
        ? listing.entries.map((entry) => ({
            key: entry.name,
            name: entry.name,
            kind: entry.kind,
            size: entry.size,
            modifiedAt: entry.modifiedAt,
            path: `${listing.path}/${entry.name}`,
            where: '',
          }))
        : [],
    [listing],
  );

  const formatSize = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${t.formatNumber(value, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
  };

  const columns: Column<Row>[] = [
    {
      id: 'name',
      header: t.t('files.name'),
      cell: (row) => (
        <div className="flex min-w-0 items-center gap-2.5">
          {kindIcon(row.kind)}
          {row.kind === 'directory' ? (
            <button
              type="button"
              className="min-w-0 truncate text-start font-medium text-fg hover:text-accent-text focus-visible:underline"
              onClick={() => {
                setQuery('');
                setCurrent(row.path);
              }}
            >
              {row.name}
            </button>
          ) : (
            <span className="min-w-0 truncate text-fg">{row.name}</span>
          )}
          {row.where && (
            <span className="hidden shrink-0 truncate text-caption text-muted md:inline">
              {row.where}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'kind',
      header: t.t('files.type'),
      hideBelow: 'md',
      cell: (row) => <span className="text-muted">{t.t(`files.kind.${row.kind}`)}</span>,
    },
    {
      id: 'modified',
      header: t.t('files.modified'),
      hideBelow: 'md',
      cell: (row) => (
        <span className="text-muted">
          {t.formatDate(row.modifiedAt, { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
      ),
    },
    {
      id: 'size',
      header: t.t('files.size'),
      hideBelow: 'lg',
      align: 'end',
      cell: (row) => (
        <span className="text-muted">{row.kind === 'file' ? formatSize(row.size) : '—'}</span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t.t('files.actions')}</span>,
      align: 'end',
      width: '11rem',
      cell: (row) => (
        <div className="flex justify-end gap-0.5">
          {row.kind === 'file' && (
            <IconButton
              size="sm"
              label={`${t.t('files.open')}: ${row.name}`}
              icon={<FolderOpen size={16} />}
              onClick={() => void open(row)}
            />
          )}
          <IconButton
            size="sm"
            label={`${t.t('files.reveal')}: ${row.name}`}
            icon={<FolderSearch size={16} />}
            onClick={() => void reveal(row)}
          />
          {row.kind !== 'other' && (
            <IconButton
              size="sm"
              label={`${t.t('files.rename')}: ${row.name}`}
              icon={<Pencil size={16} />}
              onClick={() => setDialog({ type: 'rename', row })}
            />
          )}
          {(row.kind === 'file' || row.kind === 'directory') && (
            <IconButton
              size="sm"
              label={`${t.t('files.delete')}: ${row.name}`}
              icon={<Trash2 size={16} />}
              onClick={() =>
                void change(() =>
                  invoke('files:delete', { path: row.path, folder: row.kind === 'directory' }),
                )
              }
            />
          )}
        </div>
      ),
    },
  ];

  if (overviewFailed && !overview) {
    return (
      <ScreenFrame title={t.t('files.title')}>
        <EmptyState icon={Folder} title={t.t('errors.ipc.UNKNOWN')} />
      </ScreenFrame>
    );
  }
  if (overview?.accessOff) {
    return (
      <ScreenFrame title={t.t('files.title')} description={t.t('files.description')}>
        <Card padded={false}>
          <EmptyState
            icon={ShieldOff}
            title={t.t('files.accessOff')}
            description={t.t('files.accessOffBody')}
          />
        </Card>
      </ScreenFrame>
    );
  }

  const crumbs = current ? current.split('/') : [];
  const searching = term !== '';
  const shownRows = searching ? (searchHits?.rows ?? []) : rows;

  return (
    <ScreenFrame
      title={t.t('files.title')}
      description={t.t('files.description')}
      width="wide"
      actions={
        <Button variant="secondary" leftIcon={<Plus size={16} />} onClick={() => void addFolder()}>
          {t.t('files.addFolder')}
        </Button>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <aside className="space-y-6">
          <Card padded={false} className="p-3">
            <h2 className="mb-2 px-2 text-small font-semibold text-muted">
              {t.t('files.locations')}
            </h2>
            {!overview ? (
              <Skeleton className="h-24 w-full" />
            ) : overview.roots.length === 0 ? (
              <p className="px-2 py-3 text-small text-muted">{t.t('files.addFolderHint')}</p>
            ) : (
              <ul>
                {overview.roots.map((root) => {
                  const active = current === root.label || current?.startsWith(`${root.label}/`);
                  return (
                    <li key={root.id} className="group flex items-center">
                      <button
                        type="button"
                        disabled={!root.exists}
                        aria-current={active ? 'page' : undefined}
                        title={root.exists ? root.location : t.t('files.folderMissing')}
                        onClick={() => {
                          setQuery('');
                          setCurrent(root.label);
                        }}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-2 text-start text-body',
                          'hover:bg-elevated disabled:opacity-50',
                          active ? 'bg-elevated text-fg' : 'text-muted',
                        )}
                      >
                        {root.origin === 'user' ? (
                          <HardDrive aria-hidden size={16} />
                        ) : (
                          <Folder aria-hidden size={16} />
                        )}
                        <span className="truncate">{root.label}</span>
                      </button>
                      {root.origin === 'user' && (
                        <IconButton
                          size="sm"
                          label={t.t('files.removeFolder', { name: root.label })}
                          icon={<X size={14} />}
                          onClick={() => void removeFolder(root.id, root.label)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {overview && overview.recent.length > 0 && (
            <Card padded={false} className="p-3">
              <h2 className="mb-2 px-2 text-small font-semibold text-muted">
                {t.t('files.recentFiles')}
              </h2>
              <ul>
                {overview.recent.slice(0, 6).map((item) => (
                  <li key={item.path}>
                    <button
                      type="button"
                      title={item.path}
                      onClick={() =>
                        void open({
                          key: item.path,
                          name: item.label,
                          kind: 'file',
                          size: 0,
                          modifiedAt: 0,
                          path: item.path,
                          where: '',
                        })
                      }
                      className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-start text-small text-muted hover:bg-elevated hover:text-fg"
                    >
                      <FileText aria-hidden size={14} />
                      <span className="truncate">{item.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-56 flex-1">
              <SearchInput
                value={query}
                onValueChange={setQuery}
                clearLabel={t.t('files.clearSearch')}
                placeholder={t.t('files.searchPlaceholder')}
                aria-label={t.t('files.searchPlaceholder')}
              />
            </div>
            <Button
              variant="secondary"
              leftIcon={<FolderPlus size={16} />}
              disabled={!current}
              onClick={() => setDialog({ type: 'new-folder' })}
            >
              {t.t('files.newFolder')}
            </Button>
            <IconButton
              label={t.t('files.refresh')}
              icon={<RefreshCw size={16} />}
              onClick={refresh}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {searching ? (
              <p role="status" className="text-body text-fg">
                {t.t('files.searchResults', { query: term })}
              </p>
            ) : (
              <nav aria-label={t.t('files.path')} className="flex min-w-0 items-center gap-1">
                <IconButton
                  size="sm"
                  label={t.t('files.up')}
                  icon={<ArrowUp size={16} />}
                  disabled={crumbs.length <= 1}
                  onClick={() => setCurrent(parentOf(current ?? ''))}
                />
                <ol className="flex min-w-0 flex-wrap items-center gap-1 text-body">
                  {crumbs.map((crumb, index) => {
                    const path = crumbs.slice(0, index + 1).join('/');
                    const last = index === crumbs.length - 1;
                    return (
                      <li key={path} className="flex items-center gap-1">
                        {index > 0 && (
                          <span aria-hidden className="text-muted">
                            /
                          </span>
                        )}
                        <button
                          type="button"
                          aria-current={last ? 'location' : undefined}
                          onClick={() => setCurrent(path)}
                          className={cn(
                            'rounded px-1 hover:text-accent-text',
                            last ? 'font-semibold text-fg' : 'text-muted',
                          )}
                        >
                          {crumb}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </nav>
            )}
            <div className="flex items-center gap-2 text-small text-muted">
              <Switch
                checked={showHidden}
                onCheckedChange={setShowHidden}
                label={t.t('files.showHidden')}
              />
              <span aria-hidden>{t.t('files.showHidden')}</span>
            </div>
          </div>

          {state === 'error' && !searching ? (
            <Card padded={false}>
              <EmptyState
                icon={Folder}
                title={t.t('files.loadFailed')}
                description={errorText}
                action={
                  <Button variant="secondary" onClick={refresh}>
                    {t.t('errors.tryAgain')}
                  </Button>
                }
              />
            </Card>
          ) : current === null && !searching ? (
            <Card padded={false}>
              <EmptyState
                icon={FolderOpen}
                title={t.t('files.emptyTitle')}
                description={t.t('files.emptyBody')}
              />
            </Card>
          ) : (
            <DataTable
              caption={t.t('files.title')}
              columns={columns}
              rows={shownRows}
              rowKey={(row) => row.key}
              loading={searching ? searchHits === null : state === 'loading' && !listing}
              empty={
                <p className="px-4 py-10 text-center text-body text-muted">
                  {searching ? t.t('files.searchNone') : t.t('files.emptyFolder')}
                </p>
              }
            />
          )}

          {!searching && listing && (
            <p className="text-small text-muted">
              {t.t('files.itemCount', { count: listing.total })}
              {listing.truncated &&
                ` · ${t.t('files.truncated', { count: listing.entries.length })}`}
              {listing.omitted > 0 && ` · ${t.t('files.omitted', { count: listing.omitted })}`}
            </p>
          )}
          {searchHits?.cutShort && (
            <p role="note" className="text-small text-warning">
              {t.t('files.searchCutShort')}
            </p>
          )}
        </div>
      </div>

      <section className="mt-8" aria-labelledby="files-changes">
        <Card>
          <CardHeader
            title={<span id="files-changes">{t.t('files.recentChanges')}</span>}
            description={
              overview && !overview.deletesAreRestorable ? t.t('files.trashNote') : undefined
            }
          />
          {!overview || overview.actions.length === 0 ? (
            <p className="text-body text-muted">{t.t('files.noChanges')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {overview.actions.slice(0, 8).map((action) => (
                <ActionRow
                  key={action.id}
                  action={action}
                  busy={busy}
                  onUndo={() => void change(() => invoke('files:undo', { actionId: action.id }))}
                />
              ))}
            </ul>
          )}
        </Card>
      </section>

      <NameDialog
        open={dialog?.type === 'new-folder'}
        title={t.t('files.newFolderTitle')}
        label={t.t('files.folderName')}
        confirmLabel={t.t('files.create')}
        busy={busy}
        onCancel={() => setDialog(null)}
        onSubmit={(name) =>
          current && void change(() => invoke('files:createFolder', { path: `${current}/${name}` }))
        }
      />
      <NameDialog
        open={dialog?.type === 'rename'}
        title={dialog?.type === 'rename' ? t.t('files.renameTitle', { name: dialog.row.name }) : ''}
        label={t.t('files.newName')}
        confirmLabel={t.t('files.rename')}
        initialValue={dialog?.type === 'rename' ? dialog.row.name : ''}
        busy={busy}
        onCancel={() => setDialog(null)}
        onSubmit={(name) =>
          dialog?.type === 'rename' &&
          void change(() => invoke('files:rename', { path: dialog.row.path, newName: name }))
        }
      />
    </ScreenFrame>
  );
}

function ActionRow({
  action,
  busy,
  onUndo,
}: {
  action: FileActionView;
  busy: boolean;
  onUndo: () => void;
}) {
  const t = useT();
  const name = action.label.split('/').at(-1) ?? action.label;
  const text = t.t(`files.action.${action.kind}` as TranslationKey, {
    name,
    target: action.target ?? '',
  });
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p
          className={cn(
            'truncate text-body',
            action.undone ? 'text-muted line-through' : 'text-fg',
          )}
        >
          {text}
        </p>
        <p className="text-caption text-muted">
          {t.formatDate(action.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
          {action.note && ` · ${action.note}`}
        </p>
      </div>
      {action.undone ? (
        <Badge tone="neutral">{t.t('files.undone')}</Badge>
      ) : action.undoable ? (
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Undo2 size={14} />}
          disabled={busy}
          onClick={onUndo}
        >
          {t.t('files.undo')}
        </Button>
      ) : null}
    </li>
  );
}
