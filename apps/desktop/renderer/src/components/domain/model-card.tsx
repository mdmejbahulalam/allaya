import { Globe, KeyRound, PlugZap, Trash2 } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Card } from '@renderer/components/ui/card';

export interface ProviderSummary {
  id: string;
  name: string;
  connected: boolean;
  /** e.g. `sk-…a1b2` — never the full key. */
  maskedKey?: string;
  /** Set up with an address instead of a key (a model server, or any compatible service). */
  endpoint?: { url?: string; keyless: boolean };
  models: string[];
  capabilities: string[];
  error?: string;
}

export function ModelCard({
  provider,
  testing,
  onTest,
  onRemove,
  onConfigure,
}: {
  provider: ProviderSummary;
  testing?: boolean;
  onTest?: (provider: ProviderSummary) => void;
  onRemove?: (provider: ProviderSummary) => void;
  onConfigure?: (provider: ProviderSummary) => void;
}) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-h3 font-semibold text-fg">{provider.name}</h3>
          <div className="mt-1.5">
            <Badge
              tone={provider.connected ? 'success' : provider.error ? 'danger' : 'neutral'}
              dot
            >
              {provider.connected ? t.t('models.connected') : t.t('models.notConnected')}
            </Badge>
          </div>
        </div>
      </div>
      {provider.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {provider.capabilities.map((capability) => (
            <Badge key={capability}>{capability}</Badge>
          ))}
        </div>
      )}
      {provider.models.length > 0 && (
        <p className="text-small text-muted">{provider.models.slice(0, 3).join(' · ')}</p>
      )}
      {provider.endpoint ? (
        <div className="flex items-center gap-2 rounded-control border border-line bg-bg-2 px-3 py-2 text-small">
          <Globe aria-hidden size={14} className="shrink-0 text-muted" />
          <span className="shrink-0 text-muted">{t.t('models.endpoint.address')}</span>
          <span className="ms-auto min-w-0 truncate font-mono text-fg" dir="ltr">
            {provider.endpoint.url ?? '—'}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-control border border-line bg-bg-2 px-3 py-2 text-small">
          <KeyRound aria-hidden size={14} className="text-muted" />
          <span className="text-muted">{t.t('models.apiKey')}</span>
          <span className="ms-auto font-mono text-fg">{provider.maskedKey ?? '—'}</span>
        </div>
      )}
      {provider.error && (
        <p role="alert" className="text-small text-danger-text">
          {provider.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {provider.maskedKey || provider.endpoint?.keyless ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={testing}
              leftIcon={<PlugZap size={14} />}
              onClick={() => onTest?.(provider)}
            >
              {t.t('models.testConnection')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Trash2 size={14} />}
              onClick={() => onRemove?.(provider)}
            >
              {provider.endpoint ? t.t('models.endpoint.disconnect') : t.t('models.removeKey')}
            </Button>
            {provider.endpoint && (
              <Button size="sm" variant="ghost" onClick={() => onConfigure?.(provider)}>
                {t.t('models.endpoint.change')}
              </Button>
            )}
          </>
        ) : provider.endpoint ? (
          <Button size="sm" variant="primary" onClick={() => onConfigure?.(provider)}>
            {t.t('models.endpoint.setUp')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => onConfigure?.(provider)}>
            {t.t('common.add')} {t.t('models.apiKey')}
          </Button>
        )}
      </div>
    </Card>
  );
}
