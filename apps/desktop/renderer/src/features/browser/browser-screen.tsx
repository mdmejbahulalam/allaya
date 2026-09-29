import { Globe, MonitorPlay, Plus, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { BrowserStatus } from '@allaya/validation';
import type { TranslationKey } from '@allaya/localization';
import { IpcError, invoke, subscribe } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { useSettingsStore } from '@renderer/stores/settings';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card, CardHeader } from '@renderer/components/ui/card';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Input } from '@renderer/components/ui/input';
import { Skeleton } from '@renderer/components/ui/skeleton';
import { Switch } from '@renderer/components/ui/switch';

const RULES = ['secrets', 'network', 'files', 'consequences', 'pages'] as const;

export function BrowserScreen() {
  const t = useT();
  const headless = useSettingsStore((s) => s.values['browser.headless']);
  const updateSetting = useSettingsStore((s) => s.update);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => subscribe('browser:changed', refresh), [refresh]);
  useEffect(() => {
    let cancelled = false;
    invoke('browser:getStatus').then(
      (value) => !cancelled && setStatus(value),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  /** A refusal in the user's language, the generic message for the error otherwise. */
  const explain = useCallback(
    (error: unknown): string => {
      if (error instanceof IpcError) {
        const reason = error.details?.['reason'];
        if (typeof reason === 'string' && t.has(`browser.refusal.${reason}`)) {
          return t.t(`browser.refusal.${reason}` as TranslationKey);
        }
        if (error.code === 'INVALID_INPUT') return t.t('browser.invalidDomain');
        if (t.has(`errors.ipc.${error.code}`))
          return t.t(`errors.ipc.${error.code}` as TranslationKey);
      }
      return t.t('errors.ipc.UNKNOWN');
    },
    [t],
  );

  const run = async (action: () => Promise<BrowserStatus>, success?: string) => {
    setBusy(true);
    try {
      setStatus(await action());
      if (success) toast.success(success);
    } catch (error) {
      toast.error(explain(error));
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <ScreenFrame title={t.t('browser.title')}>
        <EmptyState icon={Globe} title={t.t('errors.ipc.UNKNOWN')} />
      </ScreenFrame>
    );
  }
  if (!status) {
    return (
      <ScreenFrame title={t.t('browser.title')}>
        <Skeleton className="h-40 w-full" />
      </ScreenFrame>
    );
  }

  return (
    <ScreenFrame title={t.t('browser.title')} description={t.t('browser.description')}>
      <div className="space-y-6">
        <Card>
          <CardHeader
            title={t.t('browser.statusTitle')}
            description={status.engine ? t.t(`browser.engine.${status.engine}`) : undefined}
            action={
              status.available && (
                <Badge tone={status.running ? 'success' : 'neutral'} dot>
                  {status.running ? t.t('browser.open') : t.t('browser.notOpen')}
                  {status.running &&
                    ` ${status.headless ? t.t('browser.hidden') : t.t('browser.visible')}`}
                </Badge>
              )
            }
          />
          {!status.available ? (
            <EmptyState
              icon={Globe}
              title={t.t('browser.notInstalled')}
              description={t.t('browser.notInstalledBody')}
              className="py-6"
            />
          ) : (
            <div className="space-y-4">
              <p className="text-small text-muted">{t.t('browser.openWindowHint')}</p>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="secondary"
                  leftIcon={<MonitorPlay size={16} />}
                  loading={busy}
                  onClick={() =>
                    void run(() => invoke('browser:openWindow', {}), t.t('browser.opened'))
                  }
                >
                  {t.t('browser.openWindow')}
                </Button>
                <Button
                  variant="outline"
                  disabled={!status.running || busy}
                  onClick={() => void run(() => invoke('browser:close'), t.t('browser.closed'))}
                >
                  {t.t('browser.close')}
                </Button>
              </div>
              <div className="flex items-start gap-3 text-small">
                <Switch
                  checked={headless}
                  onCheckedChange={(value) =>
                    void updateSetting('browser.headless', value).then(refresh, () => undefined)
                  }
                  label={t.t('browser.hiddenSetting')}
                />
                <div>
                  <p className="font-medium text-fg" aria-hidden>
                    {t.t('browser.hiddenSetting')}
                  </p>
                  <p className="text-muted">{t.t('browser.hiddenSettingHint')}</p>
                </div>
              </div>
            </div>
          )}
        </Card>

        {status.running && (
          <Card>
            <CardHeader title={t.t('browser.tabsTitle')} />
            {status.tabs.length === 0 ? (
              <p className="text-body text-muted">{t.t('browser.noTabs')}</p>
            ) : (
              <ul className="divide-y divide-line" aria-label={t.t('browser.tabsTitle')}>
                {status.tabs.map((tab) => (
                  <li
                    key={tab.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-body text-fg">
                        {tab.title || t.t('browser.untitled')}
                      </p>
                      <p className="truncate text-caption text-muted">{tab.url}</p>
                    </div>
                    {tab.active && <Badge tone="accent">{t.t('browser.currentTab')}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <DomainList
            list="trusted"
            title={t.t('browser.trustedTitle')}
            hint={t.t('browser.trustedHint')}
            empty={t.t('browser.noneTrusted')}
            domains={status.trustedDomains}
            busy={busy}
            onChange={(domain, present) =>
              run(() => invoke('browser:setDomain', { list: 'trusted', domain, present }))
            }
          />
          <DomainList
            list="blocked"
            title={t.t('browser.blockedTitle')}
            hint={t.t('browser.blockedHint')}
            empty={t.t('browser.noneBlocked')}
            domains={status.blockedDomains}
            busy={busy}
            onChange={(domain, present) =>
              run(() => invoke('browser:setDomain', { list: 'blocked', domain, present }))
            }
          />
        </div>

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <ShieldCheck aria-hidden size={18} className="text-accent-text" />
                {t.t('browser.rulesTitle')}
              </span>
            }
          />
          <ul className="list-disc space-y-1.5 ps-5 text-body text-fg">
            {RULES.map((rule) => (
              <li key={rule}>{t.t(`browser.rules.${rule}`)}</li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title={t.t('browser.toolsTitle')} description={t.t('browser.toolsHint')} />
          {status.tools.length === 0 ? (
            <p className="text-body text-muted">{t.t('browser.noTools')}</p>
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
      </div>
    </ScreenFrame>
  );
}

function DomainList({
  list,
  title,
  hint,
  empty,
  domains,
  busy,
  onChange,
}: {
  list: 'trusted' | 'blocked';
  title: string;
  hint: string;
  empty: string;
  domains: string[];
  busy: boolean;
  onChange: (domain: string, present: boolean) => Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const id = `browser-${list}-input`;
  const add = async () => {
    const domain = value.trim();
    if (!domain) return;
    await onChange(domain, true);
    setValue('');
  };
  return (
    <Card data-list={list}>
      <CardHeader title={title} description={hint} />
      <form
        className="mb-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label htmlFor={id} className="sr-only">
          {t.t('browser.addSite')}
        </label>
        <Input
          id={id}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="example.com"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          maxLength={253}
        />
        <Button
          type="submit"
          variant="secondary"
          leftIcon={<Plus size={16} />}
          disabled={busy || !value.trim()}
        >
          {t.t('browser.add')}
        </Button>
      </form>
      {domains.length === 0 ? (
        <p className="text-small text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label={title}>
          {domains.map((domain) => (
            <li
              key={domain}
              className="flex items-center gap-1 rounded-pill border border-line bg-elevated ps-3 text-small text-fg"
            >
              <span dir="ltr">{domain}</span>
              <IconButton
                size="sm"
                label={t.t('browser.remove', { domain })}
                icon={<X size={14} />}
                disabled={busy}
                onClick={() => void onChange(domain, false)}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
