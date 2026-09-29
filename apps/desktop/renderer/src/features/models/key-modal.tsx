import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import type { ProviderView } from '@allaya/validation';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { toast } from '@renderer/stores/toasts';
import { Button } from '@renderer/components/ui/button';
import { Field, Input } from '@renderer/components/ui/input';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Modal } from '@renderer/components/ui/modal';

export function KeyModal({
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
      title={provider ? t.t('models.keyModalTitle', { provider: provider.name }) : ''}
      description={provider ? t.t('models.keyModalBody', { provider: provider.name }) : ''}
      size="sm"
      modalOnly
    >
      {provider && <KeyForm key={provider.id} provider={provider} onClose={onClose} />}
    </Modal>
  );
}

/**
 * Mounted fresh per provider, so the typed key lives only in this component's state and disappears with it:
 * it is sent to the main process once and never stored in any renderer store.
 */
function KeyForm({ provider, onClose }: { provider: ProviderView; onClose: () => void }) {
  const t = useT();
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const message = (err: unknown): string => {
    const code = err instanceof IpcError ? err.code : 'UNKNOWN';
    if (code === 'CREDENTIAL_STORAGE_UNAVAILABLE') return t.t('models.storageUnavailable');
    if (code === 'INVALID_INPUT' || code === 'INVALID_IPC_PAYLOAD') return t.t('models.invalidKey');
    return t.t(`errors.ipc.${(t.has(`errors.ipc.${code}`) ? code : 'UNKNOWN') as 'UNKNOWN'}`);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await invoke('providers:setKey', { providerId: provider.id, apiKey: key });
      setKey(''); // the secret leaves this component's memory as soon as it has been handed to main
      if (view.status === 'connected')
        toast.success(t.t('models.connectedToast', { provider: provider.name }));
      else toast.warning(t.t('models.savedUnverified', { provider: provider.name }));
      if (view.keyWarning) toast.info(t.t('models.keyWarning', { provider: provider.name }));
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
        if (key.trim() && !busy) void save();
      }}
      className="space-y-4"
    >
      <Field label={t.t('models.apiKey')} {...(error ? { error } : {})}>
        {(props) => (
          <Input
            {...props}
            autoFocus
            type={reveal ? 'text' : 'password'}
            value={key}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            disabled={busy}
            placeholder={t.t('models.keyPlaceholder')}
            onChange={(event) => setKey(event.target.value)}
            className="font-mono"
            rightSlot={
              <IconButton
                size="sm"
                label={reveal ? t.t('models.hideKey') : t.t('models.showKey')}
                icon={reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                onClick={() => setReveal((r) => !r)}
              />
            }
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t.t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!key.trim()}>
          {busy ? t.t('models.verifying') : t.t('common.save')}
        </Button>
      </div>
    </form>
  );
}
