import { useEffect, useLayoutEffect, useRef } from 'react';
import { useT } from '../i18n';
import { IpcError } from '../lib/api';
import { useAppStore } from '../stores/app';
import { currentModelRef, useChatStore } from '../stores/chat';
import { findModel, useConnectionsStore } from '../stores/connections';
import { AssistantMessage, errorText, UserMessage } from './message';
import { Composer } from './composer';
import { Button } from './ui';

export function ChatView({ onFailure }: { onFailure: (text: string) => void }) {
  const t = useT();
  const name = useAppStore((s) => s.settings.userName);
  const defaultModel = useAppStore((s) => s.settings.defaultModel);
  const go = useAppStore((s) => s.go);
  const { chats, activeId, messages, pendingModel } = useChatStore();
  const send = useChatStore((s) => s.send);
  const cancel = useChatStore((s) => s.cancel);
  const chooseModel = useChatStore((s) => s.chooseModel);
  const models = useConnectionsStore((s) => s.models);
  const connections = useConnectionsStore((s) => s.connections);
  const connectionsLoaded = useConnectionsStore((s) => s.loaded);

  const model = currentModelRef(chats, activeId, pendingModel, defaultModel);
  const effective = findModel(models, model)
    ? model
    : models[0]
      ? { connectionId: models[0].connectionId, modelId: models[0].modelId }
      : model;
  const busy = messages.at(-1)?.status === 'streaming';
  const noService = connectionsLoaded && connections.length === 0;

  // Keep the newest text in view while it is written — unless the person scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => {
    stick.current = true;
  }, [activeId]);

  const onSend = async (text: string) => {
    stick.current = true;
    try {
      await send(text);
    } catch (error) {
      onFailure(error instanceof IpcError ? errorText(t, error) : t.t('error.generic'));
      throw error;
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center px-6 text-center">
            {noService ? (
              <>
                <h1 className="text-2xl font-semibold">{t.t('chat.noModelTitle')}</h1>
                <p className="mt-2 text-muted">{t.t('chat.noModelBody')}</p>
                <Button
                  variant="primary"
                  className="mt-5"
                  onClick={() => go('settings', 'providers')}
                >
                  {t.t('chat.connect')}
                </Button>
              </>
            ) : (
              <>
                <p aria-hidden className="text-4xl text-accent">
                  ✦
                </p>
                <h1 className="mt-3 text-2xl font-semibold">
                  {name.trim()
                    ? t.t('chat.greeting', { name: name.trim() })
                    : t.t('chat.emptyTitle')}
                </h1>
                <p className="mt-2 text-muted">{t.t('chat.emptySub')}</p>
              </>
            )}
          </div>
        ) : (
          <div
            role="log"
            aria-label={t.t('chat.log')}
            className="mx-auto max-w-3xl space-y-6 px-4 py-6"
          >
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserMessage key={m.id} message={m} />
              ) : (
                <AssistantMessage key={m.id} message={m} />
              ),
            )}
          </div>
        )}
      </div>
      <Composer
        busy={busy}
        disabled={noService}
        model={effective}
        onModel={(m) => void chooseModel(m)}
        onSend={onSend}
        onStop={() => void cancel()}
        onConnect={() => go('settings', 'providers')}
        autoFocusKey={activeId}
      />
    </div>
  );
}
