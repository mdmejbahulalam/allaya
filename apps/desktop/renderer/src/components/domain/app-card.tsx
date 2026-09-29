import { AppWindow, Power, ScanEye, ShieldCheck } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';

export interface AppSummary {
  id: string;
  name: string;
  installed: boolean;
  running: boolean;
  automationSupport: 'uia' | 'app_api' | 'none';
  lastUsedAt?: number;
}

export function AppCard({
  app,
  onOpen,
  onClose,
  onFocus,
  onManagePermissions,
}: {
  app: AppSummary;
  onOpen?: (app: AppSummary) => void;
  onClose?: (app: AppSummary) => void;
  onFocus?: (app: AppSummary) => void;
  onManagePermissions?: (app: AppSummary) => void;
}) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl border border-line bg-elevated text-accent-text">
          <AppWindow aria-hidden size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-h3 font-semibold text-fg">{app.name}</h3>
          <p className="text-caption text-muted">
            {t.t('apps.lastUsed')}:{' '}
            {app.lastUsedAt ? t.formatRelativeTime(app.lastUsedAt) : t.t('common.never')}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge tone={app.installed ? 'success' : 'neutral'} dot>
          {t.t('apps.installed')}
        </Badge>
        {app.running && (
          <Badge tone="accent" dot>
            {t.t('apps.running')}
          </Badge>
        )}
        <Badge tone={app.automationSupport === 'none' ? 'neutral' : 'info'}>
          <ScanEye aria-hidden size={12} />
          {t.t('apps.automation')}:{' '}
          {app.automationSupport === 'none' ? t.t('common.no') : t.t('common.yes')}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        {!app.running ? (
          <Button
            size="sm"
            variant="primary"
            leftIcon={<Power size={14} />}
            onClick={() => onOpen?.(app)}
          >
            {t.t('common.open')}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={() => onFocus?.(app)}>
              {t.t('common.open')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onClose?.(app)}>
              {t.t('common.close')}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<ShieldCheck size={14} />}
          onClick={() => onManagePermissions?.(app)}
        >
          {t.t('nav.permissions')}
        </Button>
      </div>
    </Card>
  );
}
