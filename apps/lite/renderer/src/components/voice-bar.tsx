import { X } from 'lucide-react';
import { useT, type TextKey } from '../i18n';
import { useAppStore } from '../stores/app';
import { useVoiceStore, type VoiceNotice } from '../stores/voice';
import { errorText } from './message';
import { Button } from './ui';

/** The words for why voice is not going, in the person's language. */
function useNoticeText() {
  const t = useT();
  return (notice: VoiceNotice): string => {
    switch (notice.kind) {
      case 'no_stt':
        return t.t('voice.notice.no_stt');
      case 'mic':
        return t.t(`voice.notice.mic.${notice.reason}` as TextKey);
      case 'no_voice':
        return t.t('voice.notice.no_voice');
      case 'speech_failed':
        return t.t('voice.notice.speech_failed');
      case 'idle':
        return t.t('voice.notice.idle');
      case 'error':
        return t.t('voice.notice.error', {
          reason: errorText(t, { code: notice.code, message: '' }),
        });
    }
  };
}

const STATE_TEXT: Record<'listening' | 'transcribing' | 'thinking' | 'speaking', TextKey> = {
  listening: 'voice.listening',
  transcribing: 'voice.transcribing',
  thinking: 'voice.thinking',
  speaking: 'voice.speaking',
};

/** What the conversation is doing right now, with the way to end it; or why it stopped. */
export function VoiceBar() {
  const t = useT();
  const explain = useNoticeText();
  const { active, state, level, notice } = useVoiceStore();
  const end = useVoiceStore((s) => s.end);
  const skip = useVoiceStore((s) => s.skip);
  const clearNotice = useVoiceStore((s) => s.clearNotice);
  const go = useAppStore((s) => s.go);

  if (active && state !== 'idle') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-3 rounded-xl border border-line-strong bg-panel px-4 py-2 text-sm"
      >
        <span aria-hidden className="flex h-5 items-center gap-0.5">
          {[0.5, 0.8, 1, 0.8, 0.5].map((weight, i) => (
            <span
              key={i}
              className="w-1 rounded-full bg-accent transition-[height]"
              style={{ height: `${state === 'listening' ? 4 + level * 16 * weight : 4}px` }}
            />
          ))}
        </span>
        <span className="flex-1">{t.t(STATE_TEXT[state])}</span>
        {state === 'speaking' && (
          <Button size="sm" onClick={skip}>
            {t.t('voice.skip')}
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => end()}>
          {t.t('voice.end')}
        </Button>
      </div>
    );
  }
  if (notice) {
    return (
      <div
        role="status"
        className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-3 rounded-xl border border-line-strong bg-panel px-4 py-2 text-sm"
      >
        <span className="flex-1">{explain(notice)}</span>
        {(notice.kind === 'no_stt' || notice.kind === 'no_voice') && (
          <Button
            size="sm"
            onClick={() => {
              clearNotice();
              go('settings', notice.kind === 'no_stt' ? 'providers' : 'voice');
            }}
          >
            {notice.kind === 'no_stt' ? t.t('chat.connect') : t.t('voice.openSettings')}
          </Button>
        )}
        <button
          type="button"
          aria-label={t.t('voice.dismiss')}
          title={t.t('voice.dismiss')}
          onClick={clearNotice}
          className="rounded p-1 text-muted hover:bg-elevated hover:text-fg"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    );
  }
  return null;
}
