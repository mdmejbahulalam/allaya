import { History, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { RISK_LEVELS } from '@allaya/types';
import type { ActivityEntry } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { useSafetyStore } from '@renderer/stores/safety';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { Input } from '@renderer/components/ui/input';
import { Skeleton } from '@renderer/components/ui/skeleton';

const PAGE = 50;
const selectClass =
  'h-9 rounded-control border border-line bg-bg-2 px-3 text-body text-fg hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none';

const RESULT_TONE = {
  success: 'success',
  failure: 'danger',
  denied: 'warning',
  cancelled: 'neutral',
  pending: 'accent',
  info: 'neutral',
} as const;
const RISK_TONE = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'danger',
  CRITICAL: 'danger',
} as const;

type ResultFilter = 'all' | 'success' | 'failure' | 'denied' | 'cancelled';

function useExplain() {
  const t = useT();
  return (error: unknown): string =>
    error instanceof IpcError && t.has(`errors.ipc.${error.code}`)
      ? t.t(`errors.ipc.${error.code}` as TranslationKey)
      : t.t('errors.ipc.UNKNOWN');
}

function Entry({ entry }: { entry: ActivityEntry }) {
  const t = useT();
  return (
    <li
      className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0"
      data-testid="activity-entry"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-small text-muted">
          {t.formatDate(entry.timestamp, { dateStyle: 'medium', timeStyle: 'medium' })}
        </span>
        <Badge tone={RESULT_TONE[entry.result]} dot>
          {t.t(`activity.results.${entry.result}`)}
        </Badge>
        {entry.risk && <Badge tone={RISK_TONE[entry.risk]}>{t.t(`risk.${entry.risk}`)}</Badge>}
        {entry.actor !== 'allaya' && <Badge>{t.t(`activity.actors.${entry.actor}`)}</Badge>}
      </div>
      <p className="text-body break-words text-fg">{entry.action}</p>
      <p className="flex flex-wrap gap-x-3 text-small text-muted">
        {entry.tool && <span className="font-mono">{entry.tool}</span>}
        {entry.permission && t.has(`activity.permission.${entry.permission}`) && (
          <span>{t.t(`activity.permission.${entry.permission}` as TranslationKey)}</span>
        )}
      </p>
      {entry.error && <p className="text-small break-words text-danger-text">{entry.error}</p>}
    </li>
  );
}

export function ActivityScreen() {
  const t = useT();
  const explain = useExplain();
  const version = useSafetyStore((s) => s.activityVersion);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [retention, setRetention] = useState(90);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ResultFilter>('all');
  const [risk, setRisk] = useState<'all' | (typeof RISK_LEVELS)[number]>('all');
  const [clearing, setClearing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Ignore an answer that arrives after the filters have changed again.
  const latest = useRef(0);

  useEffect(() => {
    const ticket = (latest.current += 1);
    // A little pause while typing, so each key does not ask the backend.
    const timer = setTimeout(
      () => {
        invoke('activity:list', {
          limit: PAGE,
          ...(result !== 'all' ? { result } : {}),
          ...(risk !== 'all' ? { risk } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
        }).then(
          (page) => {
            if (ticket !== latest.current) return;
            setEntries(page.entries);
            setHasMore(page.hasMore);
            setRetention(page.retentionDays);
            setFailed(false);
          },
          () => ticket === latest.current && setFailed(true),
        );
      },
      query ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [query, result, risk, version]);

  const loadMore = async () => {
    const last = entries?.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await invoke('activity:list', {
        limit: PAGE,
        before: last.timestamp,
        ...(result !== 'all' ? { result } : {}),
        ...(risk !== 'all' ? { risk } : {}),
        ...(query.trim() ? { query: query.trim() } : {}),
      });
      // Entries at the very same instant as the last one shown were already listed; do not show them twice.
      const seen = new Set(entries?.map((e) => e.id));
      setEntries((current) => [...(current ?? []), ...page.entries.filter((e) => !seen.has(e.id))]);
      setHasMore(page.hasMore);
    } catch (error) {
      toast.error(explain(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = query.trim() !== '' || result !== 'all' || risk !== 'all';

  return (
    <ScreenFrame
      title={t.t('activity.title')}
      description={t.t('activity.retention', { days: retention })}
      actions={
        <Button
          variant="outline"
          leftIcon={<Trash2 size={16} />}
          disabled={entries === null || (entries.length === 0 && !filtered)}
          onClick={() => setClearing(true)}
        >
          {t.t('activity.clear')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Input
            type="search"
            className="min-w-56 flex-1"
            aria-label={t.t('activity.search')}
            placeholder={t.t('activity.search')}
            value={query}
            maxLength={100}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className={selectClass}
            aria-label={t.t('activity.resultLabel')}
            value={result}
            onChange={(event) => setResult(event.target.value as ResultFilter)}
          >
            <option value="all">{t.t('activity.allResults')}</option>
            {(['success', 'failure', 'denied', 'cancelled'] as const).map((r) => (
              <option key={r} value={r}>
                {t.t(`activity.results.${r}`)}
              </option>
            ))}
          </select>
          <select
            className={selectClass}
            aria-label={t.t('activity.riskLabel')}
            value={risk}
            onChange={(event) => setRisk(event.target.value as typeof risk)}
          >
            <option value="all">{t.t('activity.allRisks')}</option>
            {RISK_LEVELS.map((r) => (
              <option key={r} value={r}>
                {t.t(`risk.${r}`)}
              </option>
            ))}
          </select>
        </div>

        {failed ? (
          <Card>
            <p className="text-body text-muted">{t.t('errors.ipc.UNKNOWN')}</p>
          </Card>
        ) : entries === null ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : entries.length === 0 ? (
          <Card>
            {filtered ? (
              <p className="text-body text-muted">{t.t('activity.noMatch')}</p>
            ) : (
              <EmptyState
                icon={History}
                title={t.t('activity.emptyTitle')}
                description={t.t('activity.emptyBody')}
              />
            )}
          </Card>
        ) : (
          <Card>
            <ul aria-label={t.t('activity.list')}>
              {entries.map((entry) => (
                <Entry key={entry.id} entry={entry} />
              ))}
            </ul>
            {hasMore && (
              <div className="mt-3 flex justify-center">
                <Button variant="outline" loading={loadingMore} onClick={() => void loadMore()}>
                  {t.t('activity.loadMore')}
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>

      <ConfirmationDialog
        open={clearing}
        risk="HIGH"
        message={t.t('activity.clearBody')}
        confirmLabel={t.t('activity.clear')}
        onCancel={() => setClearing(false)}
        onConfirm={() => {
          setClearing(false);
          void invoke('activity:clear')
            .then(() => {
              toast.success(t.t('activity.cleared'));
              useSafetyStore.getState().bumpActivity();
            })
            .catch((error: unknown) => toast.error(explain(error)));
        }}
      />
    </ScreenFrame>
  );
}
