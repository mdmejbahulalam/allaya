import { AppWindow, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppOutcome, AppView, AppsOverview } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { Input } from '@renderer/components/ui/input';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Switch } from '@renderer/components/ui/switch';

const SUPPORT_TONE = {
  full: 'success',
  basic: 'accent',
  limited: 'warning',
  none: 'neutral',
} as const;

function AppCard({
  app,
  can,
  busy,
  onAct,
}: {
  app: AppView;
  can: AppsOverview['can'];
  busy: boolean;
  onAct: (action: 'open' | 'close' | 'focus') => void;
}) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-3" data-testid="app-card">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-elevated text-muted"
        >
          <AppWindow size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-h3 font-semibold break-words text-fg">{app.name}</h3>
          <p className="text-small text-muted">
            {app.lastUsedAt !== undefined
              ? t.t('apps.lastUsedAt', {
                  when: t.formatDate(app.lastUsedAt, { dateStyle: 'medium', timeStyle: 'short' }),
                })
              : t.t('apps.neverUsed')}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge tone={app.installed === 'yes' ? 'success' : 'neutral'} dot>
          {t.t(`apps.installedState.${app.installed}`)}
        </Badge>
        <Badge tone={app.running === true ? 'accent' : 'neutral'} dot>
          {t.t(
            `apps.runningState.${app.running === null ? 'unknown' : app.running ? 'yes' : 'no'}`,
          )}
        </Badge>
        <Badge tone={SUPPORT_TONE[app.support]} title={t.t(`apps.supportHint.${app.support}`)}>
          {t.t(`apps.support.${app.support}`)}
        </Badge>
      </div>
      <p className="text-caption text-muted">
        {t.t(`apps.supportHint.${app.support}`)}
        {app.risk !== 'LOW' && ` ${t.t('apps.riskAsk')}`}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !can.launch || app.installed === 'no'}
          onClick={() => onAct('open')}
          aria-label={`${t.t('apps.open')} ${app.name}`}
        >
          {t.t('apps.open')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !can.windows || app.running !== true}
          onClick={() => onAct('focus')}
          aria-label={`${t.t('apps.focus')} ${app.name}`}
        >
          {t.t('apps.focus')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !can.windows || app.running !== true}
          onClick={() => onAct('close')}
          aria-label={`${t.t('apps.close')} ${app.name}`}
        >
          {t.t('apps.close')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ms-auto"
          leftIcon={<ShieldCheck size={14} />}
          onClick={() => useUiStore.getState().navigate('permissions')}
        >
          {t.t('apps.permissions')}
        </Button>
      </div>
    </Card>
  );
}

export function AppsScreen() {
  const t = useT();
  const [overview, setOverview] = useState<AppsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [installedOnly, setInstalledOnly] = useState(false);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  // Which apps are running changes outside Allaya, so the list is refreshed whenever the window comes to the front.
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      invoke('apps:list').then(
        (value) => {
          if (cancelled) return;
          setOverview(value);
          setFailed(false);
        },
        () => !cancelled && setFailed(true),
      );
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [tick]);

  const act = async (app: AppView, action: 'open' | 'close' | 'focus') => {
    setBusy(app.name);
    try {
      const outcome: AppOutcome = await invoke(`apps:${action}`, { name: app.name });
      if (outcome.ok) toast.success(outcome.summary);
      else toast.error(outcome.message ?? outcome.summary);
    } catch {
      toast.error(t.t('errors.ipc.UNKNOWN'));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (overview?.apps ?? []).filter(
      (a) =>
        (!installedOnly || a.installed === 'yes') &&
        (needle === '' || a.name.toLowerCase().includes(needle)),
    );
  }, [overview, query, installedOnly]);

  return (
    <ScreenFrame
      title={t.t('apps.title')}
      description={t.t('apps.intro')}
      actions={
        <Button variant="outline" leftIcon={<RefreshCw size={16} />} onClick={reload}>
          {t.t('apps.refresh')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {overview && !overview.can.launch && !overview.can.windows && (
          <Card role="status" className="border-warning/40">
            <p className="text-small text-fg">{t.t('apps.noControl')}</p>
          </Card>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="search"
            className="min-w-56 flex-1"
            aria-label={t.t('apps.search')}
            placeholder={t.t('apps.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="flex items-center gap-2 text-small text-fg">
            <Switch
              checked={installedOnly}
              label={t.t('apps.installedOnly')}
              onCheckedChange={setInstalledOnly}
            />
            {t.t('apps.installedOnly')}
          </label>
        </div>

        {failed ? (
          <Card>
            <p className="text-body text-muted">{t.t('errors.ipc.UNKNOWN')}</p>
          </Card>
        ) : overview === null ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : shown.length === 0 ? (
          <Card>
            <EmptyState
              icon={AppWindow}
              title={overview.apps.length === 0 ? t.t('apps.emptyTitle') : t.t('apps.noMatch')}
              description={overview.apps.length === 0 ? t.t('apps.emptyBody') : ''}
            />
          </Card>
        ) : (
          <ul aria-label={t.t('apps.list')} className="grid gap-3 sm:grid-cols-2">
            {shown.map((app) => (
              <li key={app.name}>
                <AppCard
                  app={app}
                  can={overview.can}
                  busy={busy !== null}
                  onAct={(action) => void act(app, action)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </ScreenFrame>
  );
}

export type { TranslationKey };
