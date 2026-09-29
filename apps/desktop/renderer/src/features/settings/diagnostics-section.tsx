import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { Diagnostics } from '@allaya/validation';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card, CardHeader } from '@renderer/components/ui/card';
import { SettingRow } from './setting-row';

type Tone = 'ok' | 'attention' | 'off';
const BADGE: Record<Tone, 'success' | 'warning' | 'neutral'> = {
  ok: 'success',
  attention: 'warning',
  off: 'neutral',
};

function Status({ tone }: { tone: Tone }) {
  const t = useT();
  return (
    <Badge tone={BADGE[tone]} dot>
      {t.t(`settings.diagnostics.tone.${tone}`)}
    </Badge>
  );
}

function Row({ label, tone, children }: { label: string; tone?: Tone; children?: string }) {
  return (
    <SettingRow label={label}>
      <div className="flex items-center gap-3">
        {children && <span className="text-small text-muted">{children}</span>}
        {tone && <Status tone={tone} />}
      </div>
    </SettingRow>
  );
}

/** Settings → Advanced: how Allaya is doing, and a file to send when asking for help. Statuses and counts only. */
export function DiagnosticsSection() {
  const t = useT();
  const [report, setReport] = useState<Diagnostics | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke('diagnostics:get').then(
      (value) => {
        if (cancelled) return;
        setReport(value);
        setFailed(false);
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const exportFile = async () => {
    setSaving(true);
    try {
      const { saved } = await invoke('diagnostics:export');
      if (saved) toast.success(t.t('settings.diagnostics.saved'));
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'UNKNOWN';
      toast.error(t.t(`errors.ipc.${code as 'UNKNOWN'}`));
    } finally {
      setSaving(false);
    }
  };

  const yes = (value: boolean) =>
    t.t(value ? 'settings.diagnostics.yes' : 'settings.diagnostics.no');

  return (
    <div className="flex flex-col gap-4" data-testid="diagnostics">
      <Card>
        <CardHeader
          title={t.t('settings.diagnostics.title')}
          description={t.t('settings.diagnostics.hint')}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            leftIcon={<RefreshCw size={16} />}
            onClick={() => setTick((n) => n + 1)}
          >
            {t.t('settings.diagnostics.refresh')}
          </Button>
          <Button
            leftIcon={<Download size={16} />}
            loading={saving}
            onClick={() => void exportFile()}
          >
            {t.t('settings.diagnostics.export')}
          </Button>
        </div>
        <p className="mt-3 text-small text-muted">{t.t('settings.diagnostics.exportHint')}</p>
      </Card>

      {failed && (
        <p role="alert" className="text-body text-danger-text">
          {t.t('settings.diagnostics.failed')}
        </p>
      )}

      {report && (
        <Card>
          <div role="status" aria-label={t.t('settings.diagnostics.title')}>
            <Row label={t.t('settings.diagnostics.version')}>{report.app.version}</Row>
            <Row label={t.t('settings.diagnostics.electron')}>{report.app.electron}</Row>
            <Row label={t.t('settings.diagnostics.os')}>
              {`${report.app.platform} ${report.app.osVersion} (${report.app.arch})`}
            </Row>
            <Row label={t.t('settings.diagnostics.database')} tone={report.database.tone}>
              {t.t('settings.diagnostics.databaseInfo', {
                migrations: report.database.migrations,
                tables: report.database.tables,
              })}
            </Row>
            <Row label={t.t('settings.diagnostics.providers')} tone={report.providers.tone}>
              {t.t('settings.diagnostics.providersInfo', {
                connected: report.providers.connected,
                total: report.providers.total,
              })}
            </Row>
            <Row label={t.t('settings.diagnostics.voice')} tone={report.voice.tone}>
              {`${t.t(`settings.diagnostics.engine.${report.voice.speechEngine}`)} · ${yes(report.voice.enabled)}`}
            </Row>
            <Row label={t.t('settings.diagnostics.computer')} tone={report.computer.tone}>
              {report.computer.adapter}
            </Row>
            <Row label={t.t('settings.diagnostics.browser')} tone={report.browser.tone}>
              {report.browser.engine ?? t.t('settings.diagnostics.none')}
            </Row>
            <Row label={t.t('settings.diagnostics.automations')} tone={report.automations.tone}>
              {t.t('settings.diagnostics.automationsInfo', {
                enabled: report.automations.enabled,
                total: report.automations.total,
              })}
            </Row>
            <Row label={t.t('settings.diagnostics.memory')} tone={report.memory.tone}>
              {`${report.memory.count}`}
            </Row>
            <Row label={t.t('settings.diagnostics.permissions')} tone={report.permissions.tone}>
              {t.t('settings.diagnostics.permissionsInfo', {
                count: report.permissions.changed.length,
              })}
            </Row>
            <Row label={t.t('settings.diagnostics.shell')} tone={report.shell.tone}>
              {`${t.t('settings.diagnostics.tray')}: ${yes(report.shell.trayAvailable)}`}
            </Row>
            <Row label={t.t('settings.diagnostics.updates')} tone={report.updates.tone}>
              {report.updates.state}
            </Row>
          </div>
        </Card>
      )}
    </div>
  );
}
