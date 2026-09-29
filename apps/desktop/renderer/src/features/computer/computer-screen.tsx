import { CheckCircle2, MinusCircle, MonitorCog, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ComputerStatus, SelfTestResult } from '@allaya/validation';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card, CardHeader } from '@renderer/components/ui/card';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { Skeleton } from '@renderer/components/ui/skeleton';

const CAPABILITY_ORDER = [
  'windows',
  'launch',
  'screenshot',
  'clipboard',
  'mouse',
  'keyboard',
  'uiAutomation',
] as const;

export function ComputerScreen() {
  const t = useT();
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SelfTestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke('computer:getStatus').then(
      (value) => !cancelled && setStatus(value),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const runSelfTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await invoke('computer:selfTest'));
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'UNKNOWN';
      toast.error(
        t.t(`errors.ipc.${(t.has(`errors.ipc.${code}`) ? code : 'UNKNOWN') as 'UNKNOWN'}`),
      );
    } finally {
      setTesting(false);
    }
  };

  if (failed) {
    return (
      <ScreenFrame title={t.t('computer.title')}>
        <EmptyState icon={MonitorCog} title={t.t('errors.ipc.UNKNOWN')} />
      </ScreenFrame>
    );
  }
  if (!status) {
    return (
      <ScreenFrame title={t.t('computer.title')}>
        <Skeleton className="h-40 w-full" />
      </ScreenFrame>
    );
  }

  const inputMissing =
    !status.capabilities.keyboard && !status.capabilities.mouse && !status.capabilities.windows;

  return (
    <ScreenFrame title={t.t('computer.title')} description={t.t('computer.description')}>
      <div className="space-y-6">
        <Card>
          <CardHeader
            title={t.t('computer.statusTitle')}
            description={t.t('computer.platformLine', {
              platform: status.platform,
              adapter: status.adapter,
            })}
          />
          {inputMissing && (
            <p
              role="note"
              className="mb-4 rounded-control bg-elevated px-3 py-2 text-small text-muted"
            >
              {t.t('computer.windowsOnly')}
            </p>
          )}
          <h3 className="mb-2 text-small font-semibold text-muted">
            {t.t('computer.capabilitiesTitle')}
          </h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {CAPABILITY_ORDER.map((key) => {
              const on = status.capabilities[key];
              return (
                <li
                  key={key}
                  data-available={on}
                  className="flex items-center gap-2 text-body text-fg"
                >
                  {on ? (
                    <CheckCircle2 aria-hidden size={16} className="text-success" />
                  ) : (
                    <XCircle aria-hidden size={16} className="text-muted" />
                  )}
                  <span className={on ? '' : 'text-muted'}>
                    {t.t(`computer.capability.${key}`)}
                  </span>
                  <span className="sr-only">
                    {on ? t.t('computer.available') : t.t('computer.unavailable')}
                  </span>
                </li>
              );
            })}
          </ul>
          {status.screenshotsFolder && (
            <p className="mt-4 text-small text-muted">
              {t.t('computer.screenshotsFolder')}{' '}
              <code className="rounded bg-elevated px-1.5 py-0.5 text-fg [overflow-wrap:anywhere]">
                {status.screenshotsFolder}
              </code>
            </p>
          )}
        </Card>

        <Card>
          <CardHeader title={t.t('computer.toolsTitle')} description={t.t('computer.toolsHint')} />
          {status.tools.length === 0 ? (
            <p className="text-body text-muted">{t.t('computer.noTools')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {status.tools.map((tool) => (
                <li
                  key={tool.name}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <code className="text-small text-fg">{tool.name}</code>
                  <span className="flex items-center gap-2">
                    <Badge tone="neutral">
                      {tool.readOnly ? t.t('computer.readOnly') : t.t('computer.changes')}
                    </Badge>
                    <Badge
                      tone={
                        tool.risk === 'LOW'
                          ? 'success'
                          : tool.risk === 'MEDIUM' || tool.risk === 'varies'
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      {tool.risk === 'varies'
                        ? t.t('computer.risk.varies')
                        : t.t(`risk.${tool.risk}`)}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={t.t('computer.selfTest')} description={t.t('computer.selfTestHint')} />
          <Button
            variant="secondary"
            leftIcon={<ShieldCheck size={16} />}
            loading={testing}
            onClick={() => void runSelfTest()}
          >
            {testing ? t.t('computer.selfTestRunning') : t.t('computer.selfTest')}
          </Button>
          {result && (
            <div role="status" className="mt-4 space-y-2">
              <p className={result.ok ? 'text-success' : 'text-danger-text'}>
                {result.ok ? t.t('computer.selfTestPassed') : t.t('computer.selfTestFailed')}
              </p>
              <ul className="space-y-1 text-small">
                {result.steps.map((step) => (
                  <li
                    key={step.name}
                    data-ok={step.ok}
                    data-skipped={step.skipped ?? false}
                    className="flex flex-wrap items-baseline gap-2"
                  >
                    {step.skipped ? (
                      <MinusCircle aria-hidden size={14} className="text-muted" />
                    ) : step.ok ? (
                      <CheckCircle2 aria-hidden size={14} className="text-success" />
                    ) : (
                      <XCircle aria-hidden size={14} className="text-danger-text" />
                    )}
                    <span className="font-medium text-fg">
                      {t.has(`computer.selfTestStep.${step.name}`)
                        ? t.t(`computer.selfTestStep.${step.name}` as 'computer.title')
                        : step.name}
                    </span>
                    <span className="text-muted">{step.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </ScreenFrame>
  );
}
