import { KeyRound } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { IpcError } from '@renderer/lib/api';
import { useSettingsStore } from '@renderer/stores/settings';
import { toast } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { useVoiceStore } from '@renderer/stores/voice';
import { Button } from '@renderer/components/ui/button';
import { Modal } from '@renderer/components/ui/modal';

/**
 * First-use consent. Voice is off until the user reads how their audio is handled and turns it on; the
 * microphone permission in the main process follows this setting and nothing else.
 */
export function VoiceSetupModal() {
  const t = useT();
  const open = useVoiceStore((s) => s.setupOpen);
  const openSetup = useVoiceStore((s) => s.openSetup);
  const capabilities = useVoiceStore((s) => s.capabilities);
  const start = useVoiceStore((s) => s.start);
  const navigate = useUiStore((s) => s.navigate);
  const update = useSettingsStore((s) => s.update);

  const enable = async () => {
    try {
      await update('voice.enabled', true);
      openSetup(false);
      void useVoiceStore.getState().refreshCapabilities();
      // Only start listening straight away when there is something to transcribe with.
      if (capabilities?.sttAvailable) await start();
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'UNKNOWN';
      toast.error(
        t.t(`errors.ipc.${(t.has(`errors.ipc.${code}`) ? code : 'UNKNOWN') as 'UNKNOWN'}`),
      );
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={openSetup}
      title={t.t('voice.setup.title')}
      description={t.t('voice.setup.body')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => openSetup(false)}>
            {t.t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void enable()}>
            {t.t('voice.setup.enable')}
          </Button>
        </>
      }
    >
      <ul className="list-disc space-y-2 ps-5 text-body text-fg">
        {(['point1', 'point2', 'point3', 'point4'] as const).map((key) => (
          <li key={key}>{t.t(`voice.setup.${key}`)}</li>
        ))}
      </ul>
      {capabilities && !capabilities.sttAvailable && (
        <div
          role="note"
          className="mt-4 flex items-center justify-between gap-3 rounded-control bg-warning/10 p-3"
        >
          <p className="text-small text-fg">{t.t('voice.setup.noKey')}</p>
          <Button
            size="sm"
            variant="outline"
            leftIcon={<KeyRound size={14} />}
            onClick={() => {
              openSetup(false);
              navigate('models');
            }}
          >
            {t.t('voice.setup.addKey')}
          </Button>
        </div>
      )}
    </Modal>
  );
}
