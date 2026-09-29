import { useEffect } from 'react';
import { useT } from '@renderer/lib/i18n';
import { IpcError, invoke } from '@renderer/lib/api';
import { toast } from '@renderer/stores/toasts';
import { useToolsStore } from '@renderer/stores/tools';
import { useVoiceStore } from '@renderer/stores/voice';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';

/**
 * The one place the user answers "may Allaya do this?". Safe by construction: focus starts on "Don't allow",
 * Escape and clicking outside decline, and only the explicit button approves. Questions queue if several arrive.
 */
export function ToolConfirmationHost() {
  const t = useT();
  const pending = useToolsStore((s) => s.pending);
  const respond = useToolsStore((s) => s.respond);
  const load = useToolsStore((s) => s.load);
  const current = pending[0];

  // A reload while a question is open must show it again.
  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (decision: 'approved' | 'rejected') => {
    if (!current) return;
    try {
      const accepted = await respond(current.id, decision);
      if (!accepted && decision === 'approved') toast.info(t.t('tools.confirmFailed'));
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'UNKNOWN';
      toast.error(
        t.t(`errors.ipc.${(t.has(`errors.ipc.${code}`) ? code : 'UNKNOWN') as 'UNKNOWN'}`),
      );
    }
  };

  return (
    <ConfirmationDialog
      open={current !== undefined}
      risk={current?.risk ?? 'MEDIUM'}
      message={current?.summary ?? ''}
      confirmLabel={t.t('tools.allowOnce')}
      cancelLabel={t.t('tools.dontAllow')}
      // While this dialog is open the rest of the window is inert, so the emergency stop lives here too.
      reviewLabel={t.t('tools.stopEverything')}
      onReview={() => {
        useVoiceStore.getState().interrupt();
        void invoke('agent:stop').catch(() => undefined);
      }}
      onConfirm={() => void answer('approved')}
      onCancel={() => void answer('rejected')}
    >
      <p className="text-small text-muted">
        {current?.channels.includes('voice')
          ? t.t('tools.answerByVoice')
          : t.t('tools.answerOnScreen')}
      </p>
      {pending.length > 1 && (
        <p className="text-small text-muted">
          {t.t('tools.moreWaiting', { count: pending.length - 1 })}
        </p>
      )}
    </ConfirmationDialog>
  );
}
