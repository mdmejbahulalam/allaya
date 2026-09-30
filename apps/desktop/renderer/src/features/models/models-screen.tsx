import { Cpu } from 'lucide-react';
import { useState } from 'react';
import { ROUTING_PURPOSES, type RoutingPurpose } from '@allaya/types';
import type { ModelView, ProviderView } from '@allaya/validation';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { useProvidersStore, selectHasConnected } from '@renderer/stores/providers';
import { toast } from '@renderer/stores/toasts';
import { ModelCard } from '@renderer/components/domain/model-card';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Card, CardHeader } from '@renderer/components/ui/card';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { Dropdown } from '@renderer/components/ui/dropdown';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { Switch } from '@renderer/components/ui/switch';
import { EndpointModal } from './endpoint-modal';
import { KeyModal } from './key-modal';

const AUTO = '__auto__';
const refKey = (m: Pick<ModelView, 'providerId' | 'modelId'>) => `${m.providerId}::${m.modelId}`;

export function ModelsScreen() {
  const t = useT();
  const providers = useProvidersStore((s) => s.providers);
  const routing = useProvidersStore((s) => s.routing);
  const setRouting = useProvidersStore((s) => s.setRouting);
  const hasConnected = useProvidersStore(selectHasConnected);
  const [adding, setAdding] = useState<ProviderView | null>(null);
  const [removing, setRemoving] = useState<ProviderView | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const models = providers.flatMap((p) => (p.status === 'connected' ? p.models : []));

  const fail = (error: unknown) => {
    const code = error instanceof IpcError ? error.code : 'UNKNOWN';
    toast.error(t.t(`errors.ipc.${(t.has(`errors.ipc.${code}`) ? code : 'UNKNOWN') as 'UNKNOWN'}`));
  };

  const test = async (provider: ProviderView) => {
    setTesting(provider.id);
    try {
      const { result } = await invoke('providers:test', { providerId: provider.id });
      if (result.ok) toast.success(t.t('models.testOk', { ms: result.latencyMs }));
      else
        toast.error(t.t('models.testFail'), {
          description: t.t(
            `errors.ipc.${(t.has(`errors.ipc.${result.errorCode ?? ''}`) ? result.errorCode! : 'UNKNOWN') as 'UNKNOWN'}`,
          ),
        });
    } catch (error) {
      fail(error);
    } finally {
      setTesting(null);
    }
  };

  const updateRouting = (patch: Parameters<typeof setRouting>[0]) => setRouting(patch).catch(fail);

  return (
    <ScreenFrame title={t.t('models.title')} description={t.t('models.subtitle')} width="wide">
      <div className="space-y-8">
        {!hasConnected && (
          <Card padded={false}>
            <EmptyState
              icon={Cpu}
              title={t.t('models.emptyTitle')}
              description={t.t('models.emptyBody')}
            />
          </Card>
        )}

        <section aria-labelledby="providers-heading">
          <h2 id="providers-heading" className="mb-3 text-h2 font-semibold text-fg">
            {t.t('models.providers')}
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {providers.map((provider) => (
              <ModelCard
                key={provider.id}
                testing={testing === provider.id}
                provider={{
                  id: provider.id,
                  name: provider.name,
                  connected: provider.status === 'connected',
                  ...(provider.maskedKey ? { maskedKey: provider.maskedKey } : {}),
                  ...(provider.setup === 'endpoint'
                    ? {
                        endpoint: {
                          ...(provider.baseUrl ? { url: provider.baseUrl } : {}),
                          keyless: provider.keyless === true,
                        },
                      }
                    : {}),
                  models: provider.models.map((m) => m.displayName),
                  capabilities: [
                    ...new Set(
                      provider.models.flatMap((m) =>
                        Object.entries(m.capabilities)
                          .filter(
                            ([k, v]) =>
                              v === true &&
                              k in { vision: 1, tools: 1, streaming: 1, reasoning: 1 },
                          )
                          .map(([k]) => t.t(`models.caps.${k as 'vision'}`)),
                      ),
                    ),
                  ],
                  ...(provider.status === 'error' && provider.errorMessage
                    ? {
                        error: t.t(
                          `errors.ipc.${(t.has(`errors.ipc.${provider.errorCode ?? ''}`) ? provider.errorCode! : 'UNKNOWN') as 'UNKNOWN'}`,
                        ),
                      }
                    : {}),
                }}
                onConfigure={() => setAdding(provider)}
                onTest={() => void test(provider)}
                onRemove={() => setRemoving(provider)}
              />
            ))}
          </div>
        </section>

        <section aria-labelledby="routing-heading">
          <Card>
            <CardHeader
              title={<span id="routing-heading">{t.t('models.routing')}</span>}
              description={
                routing.autoRouting
                  ? t.t('models.routingAutoHint')
                  : t.t('models.routingManualHint')
              }
              action={
                <label className="flex items-center gap-3 text-small text-fg">
                  {t.t('models.autoRouting')}
                  <Switch
                    label={t.t('models.autoRouting')}
                    checked={routing.autoRouting}
                    onCheckedChange={(v) => void updateRouting({ autoRouting: v })}
                  />
                </label>
              }
            />
            {models.length === 0 ? (
              <p className="text-small text-muted">{t.t('models.needProvider')}</p>
            ) : (
              <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
                {ROUTING_PURPOSES.map((purpose: RoutingPurpose) => {
                  const assigned = routing.assignments[purpose];
                  const label = t.t(`models.purposes.${purpose}`);
                  return (
                    <div key={purpose} className="flex items-center justify-between gap-4">
                      <span className="text-body text-fg">{label}</span>
                      <Dropdown
                        label={label}
                        value={assigned ? refKey(assigned) : AUTO}
                        className="min-w-52"
                        onValueChange={(value) =>
                          void updateRouting({
                            assignments: {
                              [purpose]:
                                value === AUTO
                                  ? null
                                  : (() => {
                                      const [providerId, ...rest] = value.split('::');
                                      return { providerId, modelId: rest.join('::') } as never;
                                    })(),
                            },
                          })
                        }
                        options={[
                          { value: AUTO, label: t.t('models.automatic') },
                          ...models.map((m) => ({
                            value: refKey(m),
                            label: m.displayName,
                            description: t.t(`models.tiers.${m.tier}`),
                          })),
                        ]}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </section>
      </div>

      <KeyModal
        provider={adding?.setup === 'key' ? adding : null}
        onClose={() => setAdding(null)}
      />
      <EndpointModal
        provider={adding?.setup === 'endpoint' ? adding : null}
        onClose={() => setAdding(null)}
      />
      <ConfirmationDialog
        open={removing !== null}
        risk="MEDIUM"
        message={removing ? t.t('models.removeBody', { provider: removing.name }) : ''}
        confirmLabel={t.t('models.removeKey')}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const provider = removing;
          setRemoving(null);
          if (provider) {
            invoke('providers:removeKey', { providerId: provider.id })
              .then(() => toast.info(t.t('models.disconnectedToast', { provider: provider.name })))
              .catch(fail);
          }
        }}
      />
    </ScreenFrame>
  );
}
