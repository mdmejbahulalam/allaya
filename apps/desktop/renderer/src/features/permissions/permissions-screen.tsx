import { OctagonX, RotateCcw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PERMISSION_CATEGORIES, SENSITIVE_ACTIONS, type PermissionMode } from '@allaya/types';
import type { EmergencyStopStatus, PermissionEntry } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { useSafetyStore } from '@renderer/stores/safety';
import { useUiStore } from '@renderer/stores/ui';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { Kbd } from '@renderer/components/ui/kbd';
import { Skeleton } from '@renderer/components/ui/skeleton';

const selectClass =
  'h-9 w-full rounded-control border border-line bg-bg-2 px-3 text-body text-fg hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none sm:w-56';

function useExplain() {
  const t = useT();
  return (error: unknown): string =>
    error instanceof IpcError && t.has(`errors.ipc.${error.code}`)
      ? t.t(`errors.ipc.${error.code}` as TranslationKey)
      : t.t('errors.ipc.UNKNOWN');
}

/** `Ctrl+Shift+Escape` as separate keys. */
function Keys({ combo }: { combo: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {combo.split('+').map((key, index) => (
        <Kbd key={`${key}-${index}`}>{key}</Kbd>
      ))}
    </span>
  );
}

function EmergencyStopCard({ status }: { status: EmergencyStopStatus | null }) {
  const t = useT();
  const reason = status?.registered ? 'ok' : (status?.reason ?? 'unavailable');
  const keys = status?.accelerator ?? '';
  // The message names the keys; build it from the parts so the keys can be shown as keys.
  const [before = '', after = ''] = t
    .t(`permissions.stop.${reason}` as TranslationKey, { keys: '\u0000' })
    .split('\u0000');
  return (
    <Card variant="elevated" className="flex flex-col gap-3" data-testid="stop-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <OctagonX
            aria-hidden
            size={22}
            className={status?.registered ? 'mt-0.5 text-success' : 'mt-0.5 text-warning'}
          />
          <div className="min-w-0">
            <h2 className="text-h3 font-semibold text-fg">{t.t('permissions.stop.title')}</h2>
            {status === null ? (
              <Skeleton className="mt-2 h-4 w-72" />
            ) : (
              <p
                className="mt-1 text-small text-muted"
                role={status.registered ? undefined : 'alert'}
              >
                {before}
                <Keys combo={keys} />
                {after}
              </p>
            )}
          </div>
        </div>
        <span className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => useUiStore.getState().navigate('settings')}
          >
            {t.t('permissions.stop.change')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            leftIcon={<OctagonX size={14} />}
            onClick={() => void invoke('agent:stop').catch(() => undefined)}
          >
            {t.t('permissions.stop.now')}
          </Button>
        </span>
      </div>
    </Card>
  );
}

function PermissionRow({
  entry,
  busy,
  onChange,
}: {
  entry: PermissionEntry;
  busy: boolean;
  onChange: (mode: PermissionMode) => void;
}) {
  const t = useT();
  const name = t.t(`permissions.subjects.${entry.subject}`);
  const modes: PermissionMode[] = entry.sensitive
    ? ['ask', 'never']
    : ['always_allow', 'ask', 'never'];
  return (
    <li
      className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between"
      data-testid="permission-row"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-body font-medium text-fg">{name}</h3>
          <Badge tone={entry.mode === entry.defaultMode ? 'neutral' : 'accent'}>
            {t.t(
              entry.mode === entry.defaultMode ? 'permissions.isDefault' : 'permissions.changed',
            )}
          </Badge>
        </div>
        <p className="text-small text-muted">{t.t(`permissions.about.${entry.subject}`)}</p>
      </div>
      <select
        className={selectClass}
        aria-label={t.t('permissions.setting', { name })}
        value={entry.mode}
        disabled={busy}
        onChange={(event) => onChange(event.target.value as PermissionMode)}
      >
        {modes.map((mode) => (
          <option key={mode} value={mode}>
            {t.t(`permissions.modes.${mode}`)}
          </option>
        ))}
      </select>
    </li>
  );
}

export function PermissionsScreen() {
  const t = useT();
  const explain = useExplain();
  const safetyVersion = useSafetyStore((s) => s.safetyVersion);
  const [entries, setEntries] = useState<PermissionEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [stop, setStop] = useState<EmergencyStopStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke('permissions:list').then(
      (list) => !cancelled && setEntries(list),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The emergency-stop key is asked about again whenever the person picks another one.
  useEffect(() => {
    let cancelled = false;
    invoke('agent:getSafety').then(
      ({ emergencyStop }) => !cancelled && setStop(emergencyStop),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [safetyVersion]);

  const change = async (subject: PermissionEntry['subject'], mode: PermissionMode) => {
    setBusy(true);
    try {
      setEntries(await invoke('permissions:set', { subject, mode }));
    } catch (error) {
      toast.error(explain(error));
    } finally {
      setBusy(false);
    }
  };

  const capabilities = (entries ?? []).filter((e) =>
    (PERMISSION_CATEGORIES as readonly string[]).includes(e.subject),
  );
  const sensitive = (entries ?? []).filter((e) =>
    (SENSITIVE_ACTIONS as readonly string[]).includes(e.subject),
  );

  return (
    <ScreenFrame
      title={t.t('permissions.title')}
      description={t.t('permissions.intro')}
      actions={
        <Button
          variant="outline"
          leftIcon={<RotateCcw size={16} />}
          disabled={entries === null || entries.every((e) => e.mode === e.defaultMode)}
          onClick={() => setResetting(true)}
        >
          {t.t('permissions.reset')}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <EmergencyStopCard status={stop} />

        {failed ? (
          <Card>
            <p className="text-body text-muted">{t.t('errors.ipc.UNKNOWN')}</p>
          </Card>
        ) : entries === null ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <>
            <Card>
              <h2 className="mb-1 text-h3 font-semibold text-fg">
                {t.t('permissions.capabilities')}
              </h2>
              <ul aria-label={t.t('permissions.capabilities')}>
                {capabilities.map((entry) => (
                  <PermissionRow
                    key={entry.subject}
                    entry={entry}
                    busy={busy}
                    onChange={(mode) => void change(entry.subject, mode)}
                  />
                ))}
              </ul>
            </Card>
            <Card>
              <h2 className="text-h3 font-semibold text-fg">{t.t('permissions.sensitive')}</h2>
              <p className="mb-1 flex items-center gap-2 text-small text-muted">
                <ShieldCheck aria-hidden size={16} className="shrink-0 text-success" />
                {t.t('permissions.sensitiveNote')}
              </p>
              <ul aria-label={t.t('permissions.sensitive')}>
                {sensitive.map((entry) => (
                  <PermissionRow
                    key={entry.subject}
                    entry={entry}
                    busy={busy}
                    onChange={(mode) => void change(entry.subject, mode)}
                  />
                ))}
              </ul>
            </Card>
          </>
        )}

        <Card>
          <h2 className="mb-2 text-h3 font-semibold text-fg">{t.t('permissions.linksTitle')}</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => useUiStore.getState().navigate('files')}
            >
              {t.t('permissions.links.files')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => useUiStore.getState().navigate('browser')}
            >
              {t.t('permissions.links.browser')}
            </Button>
          </div>
        </Card>
      </div>

      <ConfirmationDialog
        open={resetting}
        risk="MEDIUM"
        message={t.t('permissions.resetBody')}
        confirmLabel={t.t('permissions.reset')}
        onCancel={() => setResetting(false)}
        onConfirm={() => {
          setResetting(false);
          void invoke('permissions:reset')
            .then((list) => {
              setEntries(list);
              toast.success(t.t('permissions.resetDone'));
            })
            .catch((error: unknown) => toast.error(explain(error)));
        }}
      />
    </ScreenFrame>
  );
}
