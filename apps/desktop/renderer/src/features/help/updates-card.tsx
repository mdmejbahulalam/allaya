import { Download, RefreshCw, RotateCw } from 'lucide-react';
import { useEffect } from 'react';
import type { UpdateStatus } from '@allaya/validation';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { useAppInfoStore } from '@renderer/stores/app-info';
import { useUpdatesStore } from '@renderer/stores/updates';
import { Button } from '@renderer/components/ui/button';
import { Card, CardHeader } from '@renderer/components/ui/card';
import { Progress } from '@renderer/components/ui/progress';

/** Where an update stands, and the person's buttons. Nothing installs unless they press "Restart and install". */
export function UpdatesCard() {
  const t = useT();
  const status = useUpdatesStore((s) => s.status);
  const set = useUpdatesStore((s) => s.set);
  const version = useAppInfoStore((s) => s.version);

  useEffect(() => {
    let cancelled = false;
    invoke('updates:getStatus').then(
      (current) => !cancelled && set(current),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [set]);

  const run = async (channel: 'updates:check' | 'updates:download') => {
    try {
      set(await invoke(channel));
    } catch {
      toast.error(t.t('updates.error'));
    }
  };
  const install = async () => {
    try {
      await invoke('updates:install');
    } catch (error) {
      toast.error(
        error instanceof IpcError && error.details?.['reason'] === 'busy'
          ? t.t('updates.busy')
          : t.t('errors.ipc.UNKNOWN'),
      );
    }
  };

  const s: UpdateStatus = status ?? { state: 'idle' };
  const busy = s.state === 'checking' || s.state === 'downloading';
  return (
    <Card data-testid="updates-card">
      <CardHeader title={t.t('updates.title')} />
      <div className="flex flex-col gap-3">
        {version && <p className="text-body text-fg">{t.t('updates.current', { version })}</p>}
        <div role="status" className="text-body text-muted">
          {s.state === 'unsupported' && t.t('updates.unsupported')}
          {s.state === 'checking' && t.t('updates.checking')}
          {s.state === 'up_to_date' && t.t('updates.upToDate')}
          {s.state === 'available' && t.t('updates.available', { version: s.version })}
          {s.state === 'downloading' &&
            t.t('updates.downloading', { version: s.version, percent: Math.round(s.percent) })}
          {s.state === 'ready' && t.t('updates.ready', { version: s.version })}
          {s.state === 'error' && t.t('updates.error')}
        </div>
        {s.state === 'downloading' && <Progress value={s.percent} label={t.t('updates.title')} />}
        {s.state !== 'unsupported' && (
          <div className="flex flex-wrap gap-2">
            {s.state === 'ready' ? (
              <Button
                variant="primary"
                leftIcon={<RotateCw size={16} />}
                onClick={() => void install()}
              >
                {t.t('updates.install')}
              </Button>
            ) : s.state === 'available' ? (
              <Button
                variant="primary"
                leftIcon={<Download size={16} />}
                onClick={() => void run('updates:download')}
              >
                {t.t('updates.download')}
              </Button>
            ) : (
              <Button
                variant="outline"
                leftIcon={<RefreshCw size={16} />}
                disabled={busy}
                onClick={() => void run('updates:check')}
              >
                {t.t('updates.check')}
              </Button>
            )}
          </div>
        )}
        {s.state !== 'unsupported' && (
          <p className="text-caption text-muted">{t.t('updates.verify')}</p>
        )}
      </div>
    </Card>
  );
}
