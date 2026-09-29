import { Check, Copy, RotateCcw, Sparkles, KeyRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MessageView } from '@allaya/validation';
import { useT } from '@renderer/lib/i18n';
import { Markdown } from '@renderer/lib/markdown';
import { textLang } from '@renderer/lib/text-lang';
import { cn } from '@renderer/lib/cn';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { IconButton } from '@renderer/components/ui/icon-button';
import { useToolsStore } from '@renderer/stores/tools';
import { ActionTimeline } from '../tools/action-timeline';

export function UserBubble({ message }: { message: MessageView }) {
  const lang = useMemo(() => textLang(message.content), [message.content]);
  return (
    <div className="flex justify-end">
      <div
        lang={lang}
        className="max-w-[80%] rounded-2xl rounded-ee-md bg-accent-solid px-4 py-2.5 text-body break-words whitespace-pre-wrap text-accent-fg"
      >
        {message.content}
      </div>
    </div>
  );
}

function TypingDots({ label }: { label: string }) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center gap-1 py-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className="size-1.5 rounded-full bg-muted animate-pulse-soft"
          style={{ animationDelay: `${i * 180}ms` }}
        />
      ))}
    </span>
  );
}

const NEEDS_SETUP = new Set(['PROVIDER_NOT_CONFIGURED', 'PROVIDER_AUTH_FAILED']);

export function AssistantBubble({
  message,
  liveText,
  onRetry,
  onConfigure,
}: {
  message: MessageView;
  /** Text streamed so far (takes precedence while generating). */
  liveText?: string | undefined;
  onRetry?: (() => void) | undefined;
  onConfigure?: (() => void) | undefined;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const streaming = message.status === 'streaming';
  const text = streaming ? (liveText ?? message.content) : message.content;
  const failed = message.status === 'error';
  const lang = useMemo(() => textLang(text), [text]);
  const liveActions = useToolsStore((s) => s.live[message.id]);
  const actions =
    liveActions && liveActions.length >= (message.actions?.length ?? 0)
      ? liveActions
      : message.actions;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard permission denied: nothing useful to do */
    }
  };

  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="gradient-accent mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-white"
      >
        <Sparkles size={16} />
      </span>
      <div className="min-w-0 flex-1">
        {streaming && text === '' ? (
          <TypingDots label={t.t('chat.generatingLabel')} />
        ) : (
          text && (
            <div lang={lang} className="text-body text-fg">
              <Markdown text={text} />
              {streaming && (
                <span
                  aria-hidden
                  className="ms-0.5 inline-block h-4 w-1.5 translate-y-0.5 rounded-sm bg-accent animate-pulse-soft"
                />
              )}
            </div>
          )
        )}

        {actions && <ActionTimeline actions={actions} />}

        {failed && message.error && (
          <div role="alert" className="mt-2 rounded-xl border border-danger/30 bg-danger/8 p-3">
            <p className="text-body font-medium text-danger-text">{t.t('chat.couldntReply')}</p>
            <p className="mt-0.5 text-small text-muted">
              {t.t(
                `errors.ipc.${(t.has(`errors.ipc.${message.error.code}`) ? message.error.code : 'UNKNOWN') as 'UNKNOWN'}`,
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {NEEDS_SETUP.has(message.error.code) && onConfigure && (
                <Button
                  size="sm"
                  variant="primary"
                  leftIcon={<KeyRound size={14} />}
                  onClick={onConfigure}
                >
                  {t.t('chat.configureAi')}
                </Button>
              )}
              {onRetry && (
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<RotateCcw size={14} />}
                  onClick={onRetry}
                >
                  {t.t('chat.retry')}
                </Button>
              )}
            </div>
          </div>
        )}

        {!streaming && (
          <div
            className={cn(
              'mt-1.5 flex items-center gap-2 text-caption text-muted',
              failed && 'mt-2',
            )}
          >
            {message.status === 'cancelled' && <Badge tone="warning">{t.t('chat.stopped')}</Badge>}
            {message.model && (
              <span title={message.routeReason}>
                {t.t('chat.viaModel', { model: message.model.displayName })}
              </span>
            )}
            {message.status === 'complete' && message.content && (
              <IconButton
                size="sm"
                label={copied ? t.t('chat.copied') : t.t('chat.copy')}
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
                onClick={() => void copy()}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
