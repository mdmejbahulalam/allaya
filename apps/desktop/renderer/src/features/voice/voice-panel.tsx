import { X } from 'lucide-react';
import { useState } from 'react';
import type { TranslationKey } from '@allaya/localization';
import { useT } from '@renderer/lib/i18n';
import { useVoiceStore, type VoiceNotice } from '@renderer/stores/voice';
import { VoiceVisualizer } from '@renderer/components/domain/voice-visualizer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Textarea } from '@renderer/components/ui/input';

export function useNoticeText() {
  const t = useT();
  return (notice: VoiceNotice): string => {
    const key: TranslationKey = (() => {
      switch (notice.kind) {
        case 'no_speech':
          return 'voice.notice.no_speech';
        case 'no_voice':
          return notice.language === 'bn' ? 'voice.notice.no_voice_bn' : 'voice.notice.no_voice_en';
        case 'speech_failed':
          return 'voice.notice.speech_failed';
        case 'conversation_idle':
          return 'voice.notice.conversation_idle';
        case 'error': {
          const mic = `voice.notice.${notice.code === 'mic_permission_denied' ? 'mic_permission_denied' : notice.code}`;
          if (t.has(mic)) return mic as TranslationKey;
          const ipc = `errors.ipc.${notice.code}`;
          return (t.has(ipc) ? ipc : 'voice.notice.generic') as TranslationKey;
        }
      }
    })();
    return t.t(key);
  };
}

/** Live voice feedback above the composer: level meter while listening, the review card for uncertain input. */
export function VoicePanel() {
  const t = useT();
  const noticeText = useNoticeText();
  const state = useVoiceStore((s) => s.state);
  const levels = useVoiceStore((s) => s.levels);
  const review = useVoiceStore((s) => s.review);
  const notice = useVoiceStore((s) => s.notice);
  const interrupt = useVoiceStore((s) => s.interrupt);
  const conversation = useVoiceStore((s) => s.conversation);
  const awaitingReply = useVoiceStore((s) => s.awaitingReply);
  const endConversation = useVoiceStore((s) => s.endConversation);
  const skip = useVoiceStore((s) => s.skip);
  const dismissNotice = useVoiceStore((s) => s.dismissNotice);

  const busy = state === 'LISTENING' || state === 'PROCESSING' || state === 'SPEAKING';
  // A hands-free conversation keeps its panel between turns, so the way to end it is always in reach.
  const active = busy || (conversation && !review);
  if (!active && !review && !notice) return null;

  const status =
    state === 'LISTENING'
      ? t.t(conversation ? 'voice.conversation.listening' : 'voice.listeningHint')
      : state === 'PROCESSING'
        ? t.t('voice.processingLabel')
        : state === 'SPEAKING'
          ? t.t('voice.speakingHint')
          : t.t(awaitingReply ? 'voice.conversation.waiting' : 'voice.conversation.ready');

  return (
    <section
      aria-label={t.t('voice.panelLabel')}
      className="mx-auto mb-3 w-full max-w-3xl rounded-2xl border border-line bg-surface p-4 shadow-soft"
    >
      {active && (
        <div className="flex items-center gap-4">
          <VoiceVisualizer
            state={state}
            {...(state === 'LISTENING' && levels.length > 0 ? { levels } : {})}
            className="min-w-0 flex-1"
          />
          <p role="status" className="shrink-0 text-small text-muted">
            {status}
          </p>
          {conversation ? (
            <>
              {state === 'SPEAKING' && (
                <Button size="sm" variant="outline" onClick={skip}>
                  {t.t('voice.skip')}
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => endConversation()}>
                {t.t('voice.endConversation')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={interrupt}>
              {t.t('common.cancel')}
            </Button>
          )}
        </div>
      )}

      {active && conversation && (
        <p className="mt-2 text-caption text-muted">{t.t('voice.conversation.hint')}</p>
      )}

      {!busy && review && <ReviewCard key={review.text} />}

      {!busy && !review && !(conversation && !notice) && notice && (
        <div role="status" className="flex items-start justify-between gap-3">
          <p className="text-body text-fg">{noticeText(notice)}</p>
          <IconButton
            label={t.t('toast.dismiss')}
            size="sm"
            icon={<X size={16} />}
            onClick={dismissNotice}
          />
        </div>
      )}
    </section>
  );
}

function ReviewCard() {
  const t = useT();
  const review = useVoiceStore((s) => s.review)!;
  const confirmReview = useVoiceStore((s) => s.confirmReview);
  const dismissReview = useVoiceStore((s) => s.dismissReview);
  const start = useVoiceStore((s) => s.start);
  const [text, setText] = useState(review.text);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-h3 font-semibold text-fg">{t.t('voice.reviewTitle')}</h2>
        <Badge
          tone={
            review.confidence === null
              ? 'neutral'
              : review.confidence >= 0.7
                ? 'success'
                : 'warning'
          }
        >
          {review.confidence === null
            ? t.t('voice.confidenceUnknown')
            : t.t('voice.confidence', { percent: Math.round(review.confidence * 100) })}
        </Badge>
      </div>
      <p className="text-small text-muted">{t.t('voice.reviewHint')}</p>
      <ul className="space-y-1">
        {review.reasons.map((reason) => (
          <li
            key={reason}
            className={
              reason === 'destructive'
                ? 'text-small font-medium text-danger-text'
                : 'text-small text-muted'
            }
          >
            {t.t(`voice.reason.${reason}`)}
          </li>
        ))}
      </ul>
      <Textarea
        aria-label={t.t('voice.reviewLabel')}
        autoGrow
        rows={2}
        maxRows={6}
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            confirmReview(text);
          }
        }}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={dismissReview}>
          {t.t('common.cancel')}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            dismissReview();
            void start();
          }}
        >
          {t.t('voice.speakAgain')}
        </Button>
        <Button variant="primary" disabled={!text.trim()} onClick={() => confirmReview(text)}>
          {t.t('voice.sendReviewed')}
        </Button>
      </div>
    </div>
  );
}
