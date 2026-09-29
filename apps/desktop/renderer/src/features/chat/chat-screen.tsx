import { KeyRound, MessagesSquare, PanelLeft, SendHorizontal, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationView, MessageView, ModelRefView } from '@allaya/validation';
import { IpcError } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { useViewportTier } from '@renderer/lib/use-viewport';
import { useAgentStore } from '@renderer/stores/agent';
import { useChatStore } from '@renderer/stores/chat';
import {
  useProvidersStore,
  selectConnection,
  selectHasConnected,
} from '@renderer/stores/providers';
import { useSettingsStore } from '@renderer/stores/settings';
import { toast } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { Button } from '@renderer/components/ui/button';
import { ConfirmationDialog } from '@renderer/components/ui/confirmation-dialog';
import { Drawer } from '@renderer/components/ui/drawer';
import { Dropdown } from '@renderer/components/ui/dropdown';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { IconButton } from '@renderer/components/ui/icon-button';
import { Textarea } from '@renderer/components/ui/input';
import { AssistantBubble, UserBubble } from './message-bubble';
import { ConversationList } from './conversation-list';
import { VoiceButton } from '../voice/voice-button';
import { VoicePanel } from '../voice/voice-panel';

const AUTO = '__auto__';
const NO_MESSAGES: MessageView[] = [];
const STICK_THRESHOLD = 80;

export function ChatScreen() {
  const t = useT();
  const tier = useViewportTier();
  const navigate = useUiStore((s) => s.navigate);
  const chat = useChatStore();
  const providers = useProvidersStore((s) => s.providers);
  const connection = useProvidersStore(selectConnection);
  const hasConnected = useProvidersStore(selectHasConnected);
  const responseLanguage = useSettingsStore((s) => s.values['language.response']);
  const isWorking = useAgentStore((s) => s.isWorking);

  const [text, setText] = useState('');
  const [pinned, setPinned] = useState<string>(AUTO);
  const [listOpen, setListOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ConversationView | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const messages = chat.activeId ? (chat.messages[chat.activeId] ?? NO_MESSAGES) : NO_MESSAGES;
  const generating = messages.some((m) => m.status === 'streaming');

  const models = useMemo(
    () => providers.flatMap((p) => (p.status === 'connected' ? p.models : [])),
    [providers],
  );
  const pinnedRef: ModelRefView | undefined = useMemo(() => {
    const found = models.find((m) => `${m.providerId}::${m.modelId}` === pinned);
    return found ? { providerId: found.providerId, modelId: found.modelId } : undefined;
  }, [models, pinned]);

  const send = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    stick.current = true;
    try {
      await chat.send(trimmed, pinnedRef);
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'UNKNOWN';
      toast.error(
        t.t(`errors.ipc.${(t.has(`errors.ipc.${code}`) ? code : 'UNKNOWN') as 'UNKNOWN'}`),
      );
    }
  };

  // Hand-off from Home / the command palette: the staged draft is sent once, then cleared.
  useEffect(() => {
    const draft = useUiStore.getState().composerDraft;
    if (draft.trim()) {
      useUiStore.getState().setComposerDraft('');
      void send(draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once on mount
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, chat.streaming]);

  // Screen-reader announcements: one polite message when a reply starts and when it completes —
  // not every streamed fragment.
  const lastStatus = useRef<string>('');
  useEffect(() => {
    const last = messages[messages.length - 1];
    const key = last ? `${last.id}:${last.status ?? ''}` : '';
    if (key === lastStatus.current || !last || last.kind !== 'assistant') return;
    lastStatus.current = key;
    setAnnouncement(
      last.status === 'streaming'
        ? t.t('chat.generatingLabel')
        : last.status === 'complete'
          ? last.content
          : '',
    );
  }, [messages, t]);

  const conversationList = (
    <ConversationList
      conversations={chat.conversations}
      activeId={chat.activeId}
      onSelect={(id) => {
        void chat.select(id);
        setListOpen(false);
      }}
      onNew={() => {
        void chat.select(null);
        setListOpen(false);
      }}
      onRename={(id, title) => void chat.rename(id, title)}
      onDelete={setToDelete}
    />
  );

  const showInlineList = tier === 'xl' || tier === 'lg';
  const activeConversation = chat.conversations.find((c) => c.id === chat.activeId);
  // A conversation-level choice ("Speak English") is more specific than the app-wide reply policy.
  const languageLabel = t.t(`chat.lang.${activeConversation?.language ?? responseLanguage}`);
  const retryFor = (index: number) => {
    const previousUser = [...messages.slice(0, index)].reverse().find((m) => m.kind === 'user');
    return previousUser && !generating ? () => void send(previousUser.content) : undefined;
  };

  return (
    <div className="flex h-full">
      {showInlineList && (
        <aside className="w-[260px] shrink-0 border-e border-line bg-bg-2">
          {conversationList}
        </aside>
      )}

      <section aria-label={t.t('chat.title')} className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3">
          {!showInlineList && (
            <IconButton
              label={t.t('chat.conversationsList')}
              icon={<PanelLeft size={18} />}
              onClick={() => setListOpen(true)}
            />
          )}
          <div className="min-w-0">
            <h1 className="text-h3 font-semibold text-fg">{t.t('chat.assistant')}</h1>
            <p className="flex flex-wrap items-center gap-x-3 text-caption text-muted">
              <span>{t.t('chat.languageValue', { language: languageLabel })}</span>
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`size-1.5 rounded-full ${connection === 'online' ? 'bg-success' : 'bg-warning'}`}
                />
                {connection === 'online' ? t.t('chat.connected') : t.t('chat.disconnected')}
              </span>
            </p>
          </div>
          <div className="ms-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            {activeConversation && (
              <div className="flex items-center gap-2">
                <span className="text-small text-muted">{t.t('chat.replyLanguage')}</span>
                <Dropdown
                  label={t.t('chat.replyLanguage')}
                  value={activeConversation.language ?? 'auto'}
                  onValueChange={(value) =>
                    void chat
                      .setLanguage(activeConversation.id, value as 'auto' | 'bn' | 'en')
                      .catch(() => toast.error(t.t('errors.ipc.UNKNOWN')))
                  }
                  className="min-w-36"
                  options={[
                    { value: 'auto', label: t.t('chat.lang.auto') },
                    { value: 'bn', label: t.t('chat.autonym.bn') },
                    { value: 'en', label: t.t('chat.autonym.en') },
                  ]}
                />
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-small text-muted">{t.t('chat.modelLabel')}</span>
              <Dropdown
                label={t.t('chat.modelLabel')}
                value={pinnedRef ? pinned : AUTO}
                onValueChange={setPinned}
                disabled={models.length === 0}
                className="min-w-48"
                options={[
                  { value: AUTO, label: t.t('chat.modelAuto') },
                  ...models.map((m) => ({
                    value: `${m.providerId}::${m.modelId}`,
                    label: m.displayName,
                  })),
                ]}
              />
            </div>
          </div>
        </header>

        <div
          ref={scroller}
          role="log"
          aria-label={t.t('chat.messageList')}
          aria-busy={generating}
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {messages.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title={t.t('chat.emptyTitle')}
              description={t.t('chat.emptyBody')}
              className="h-full"
            />
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-6">
              {messages.map((message, index) =>
                message.kind === 'user' ? (
                  <UserBubble key={message.id} message={message} />
                ) : (
                  <AssistantBubble
                    key={message.id}
                    message={message}
                    liveText={chat.streaming[message.id]}
                    onRetry={retryFor(index)}
                    onConfigure={() => navigate('models')}
                  />
                ),
              )}
            </div>
          )}
        </div>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>

        <div className="border-t border-line bg-bg px-5 py-4">
          <div className="mx-auto w-full max-w-3xl">
            {!hasConnected && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-2.5">
                <span className="flex items-center gap-2 text-small text-fg">
                  <KeyRound aria-hidden size={16} className="text-warning" />
                  {t.t('chat.notConfiguredBanner')}
                </span>
                <Button size="sm" variant="primary" onClick={() => navigate('models')}>
                  {t.t('chat.configureAi')}
                </Button>
              </div>
            )}
            <VoicePanel />
            <div className="flex items-end gap-2 rounded-card border border-line bg-card p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
              <Textarea
                autoGrow
                rows={1}
                maxRows={8}
                aria-label={t.t('chat.inputPlaceholder')}
                placeholder={t.t('chat.inputPlaceholder')}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter is a newline, and never send mid-IME composition (Bengali input).
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (!generating && text.trim()) {
                      void send(text);
                      setText('');
                    }
                  }
                }}
                className="border-transparent bg-transparent hover:border-transparent focus:border-transparent focus:ring-0"
              />
              <VoiceButton />
              {generating || isWorking ? (
                <Button
                  variant="danger"
                  aria-label={t.t('chat.stopGenerating')}
                  title={t.t('chat.stopGenerating')}
                  onClick={() => void chat.cancel()}
                >
                  <Square aria-hidden size={16} fill="currentColor" />
                </Button>
              ) : (
                <Button
                  variant="gradient"
                  aria-label={t.t('chat.send')}
                  disabled={!text.trim()}
                  onClick={() => {
                    void send(text);
                    setText('');
                  }}
                >
                  <SendHorizontal aria-hidden size={18} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      <Drawer
        open={listOpen && !showInlineList}
        onOpenChange={setListOpen}
        title={t.t('chat.conversationsList')}
        width={300}
      >
        <div className="-m-4 h-[calc(100%+2rem)]">{conversationList}</div>
      </Drawer>

      <ConfirmationDialog
        open={toDelete !== null}
        risk="MEDIUM"
        message={t.t('chat.deleteBody')}
        {...(toDelete ? { location: toDelete.title } : {})}
        confirmLabel={t.t('common.delete')}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void chat.remove(toDelete.id);
          setToDelete(null);
        }}
      />
    </div>
  );
}
