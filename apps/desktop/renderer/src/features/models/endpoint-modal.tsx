import { useState } from 'react';
import type { ProviderView } from '@allaya/validation';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { Button } from '@renderer/components/ui/button';
import { Field, Input } from '@renderer/components/ui/input';
import { Modal } from '@renderer/components/ui/modal';

/** The usual address for each kind of server, offered as a starting point. */
const SUGGESTION: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
  custom: 'http://localhost:1234/v1',
};

export function EndpointModal({
  provider,
  onClose,
}: {
  provider: ProviderView | null;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal
      open={provider !== null}
      onOpenChange={(open) => !open && onClose()}
      title={provider ? t.t('models.endpoint.title', { provider: provider.name }) : ''}
      description={provider ? t.t('models.endpoint.body') : ''}
      size="sm"
      modalOnly
    >
      {provider && <EndpointForm key={provider.id} provider={provider} onClose={onClose} />}
    </Modal>
  );
}

/** Mounted fresh per provider, so a typed key lives only here and is sent to the main process once. */
function EndpointForm({ provider, onClose }: { provider: ProviderView; onClose: () => void }) {
  const t = useT();
  const [url, setUrl] = useState(provider.baseUrl ?? SUGGESTION[provider.id] ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const message = (err: unknown): string => {
    if (err instanceof IpcError) {
      if (err.code === 'INVALID_INPUT' || err.code === 'INVALID_IPC_PAYLOAD') {
        const reason = err.details?.['reason'];
        return t.t(
          typeof reason === 'string' && t.has(`models.endpoint.refused.${reason}`)
            ? (`models.endpoint.refused.${reason}` as 'models.endpoint.refused.empty')
            : 'models.endpoint.refused.malformed',
        );
      }
      if (err.code === 'CREDENTIAL_STORAGE_UNAVAILABLE') return t.t('models.storageUnavailable');
      return t.t(
        `errors.ipc.${(t.has(`errors.ipc.${err.code}`) ? err.code : 'UNKNOWN') as 'UNKNOWN'}`,
      );
    }
    return t.t('errors.ipc.UNKNOWN');
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await invoke('providers:setEndpoint', {
        providerId: provider.id as 'ollama' | 'custom',
        baseUrl: url.trim(),
        ...(key.trim() ? { apiKey: key.trim() } : {}),
      });
      setKey('');
      if (view.status === 'connected')
        toast.success(t.t('models.connectedToast', { provider: provider.name }));
      else toast.warning(t.t('models.endpoint.unreachable', { provider: provider.name }));
      onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (url.trim() && !busy) void save();
      }}
      className="space-y-4"
    >
      <Field label={t.t('models.endpoint.address')} {...(error ? { error } : {})}>
        {(props) => (
          <Input
            {...props}
            autoFocus
            value={url}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            disabled={busy}
            placeholder={SUGGESTION[provider.id] ?? 'https://…'}
            onChange={(event) => setUrl(event.target.value)}
            className="font-mono"
          />
        )}
      </Field>
      <p className="text-caption text-muted">{t.t('models.endpoint.addressHint')}</p>
      <Field label={t.t('models.endpoint.keyOptional')}>
        {(props) => (
          <Input
            {...props}
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
            className="font-mono"
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t.t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!url.trim()}>
          {busy ? t.t('models.verifying') : t.t('common.save')}
        </Button>
      </div>
    </form>
  );
}
