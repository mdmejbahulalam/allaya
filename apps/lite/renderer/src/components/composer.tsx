import { ArrowUp, Square } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelRef } from '../../../shared/ipc';
import { useT } from '../i18n';
import { cn } from '../lib/cn';
import { ModelPicker } from './model-picker';

/**
 * The box at the bottom: Enter sends, Shift+Enter starts a new line, and while a reply is being written the button
 * becomes Stop. The model of the chat is under the box, where it is easy to see and change.
 */
export function Composer({
  busy,
  disabled,
  model,
  onModel,
  onSend,
  onStop,
  onConnect,
  autoFocusKey,
}: {
  busy: boolean;
  /** No model to talk to yet. */
  disabled: boolean;
  model: ModelRef | null;
  onModel: (model: ModelRef) => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onConnect: () => void;
  /** Changes when the box should take focus (another chat was opened). */
  autoFocusKey: string | null;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  useLayoutEffect(() => {
    box.current?.focus();
  }, [autoFocusKey]);

  const canSend = text.trim().length > 0 && !busy && !disabled;
  const submit = () => {
    if (!canSend) return;
    const value = text;
    setText('');
    onSend(value).catch(() => setText(value));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="rounded-2xl border border-line-strong bg-panel focus-within:border-accent">
        <textarea
          ref={box}
          value={text}
          rows={1}
          dir="auto"
          aria-label={t.t('chat.placeholder')}
          placeholder={t.t('chat.placeholder')}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3 pb-1 outline-none focus-visible:outline-none placeholder:text-muted/70"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <ModelPicker value={model} onPick={onModel} onConnect={onConnect} openUp />
          {busy ? (
            <button
              type="button"
              aria-label={t.t('chat.stop')}
              title={t.t('chat.stop')}
              onClick={onStop}
              className="inline-flex size-8 items-center justify-center rounded-full bg-fg text-bg"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              aria-label={t.t('chat.send')}
              title={t.t('chat.send')}
              disabled={!canSend}
              onClick={submit}
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity',
                !canSend && 'opacity-40',
              )}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-center text-xs text-muted">{t.t('chat.hint')}</p>
    </div>
  );
}
