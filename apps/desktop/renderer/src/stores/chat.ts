import { create } from 'zustand';
import type { ConversationView, MessageView, ModelRefView } from '@allaya/validation';
import { invoke } from '@renderer/lib/api';

interface ChatState {
  conversations: ConversationView[];
  activeId: string | null;
  /** Messages by conversation id (loaded lazily). */
  messages: Record<string, MessageView[]>;
  /** Text streamed so far for messages still being generated, by message id. */
  streaming: Record<string, string>;
  loadConversations: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  send: (text: string, model?: ModelRefView) => Promise<void>;
  cancel: () => Promise<void>;
  setLanguage: (id: string, language: 'auto' | 'bn' | 'en') => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  applyDelta: (messageId: string, text: string) => void;
  applyFinished: (message: MessageView) => void;
  setConversations: (list: ConversationView[]) => void;
}

/**
 * Insert or replace by id. A `chat:finished` event can arrive before the `chat:send` response is processed;
 * a finished message must never be overwritten by the older "streaming" placeholder.
 */
export function upsertMessage(list: MessageView[], incoming: MessageView): MessageView[] {
  const index = list.findIndex((m) => m.id === incoming.id);
  if (index === -1) return [...list, incoming];
  const existing = list[index]!;
  if (existing.status && existing.status !== 'streaming' && incoming.status === 'streaming')
    return list;
  const next = list.slice();
  next[index] = incoming;
  return next;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: {},
  streaming: {},

  setConversations: (conversations) => set({ conversations }),

  async loadConversations() {
    set({ conversations: await invoke('chat:listConversations') });
  },

  async select(id) {
    set({ activeId: id });
    if (id && !get().messages[id]) {
      const messages = await invoke('chat:getMessages', { conversationId: id });
      set((s) => ({ messages: { ...s.messages, [id]: messages } }));
    }
  },

  async send(text, model) {
    const { activeId } = get();
    const result = await invoke('chat:send', {
      text,
      ...(activeId ? { conversationId: activeId } : {}),
      ...(model ? { model } : {}),
    });
    set((s) => {
      const id = result.conversation.id;
      const known = s.conversations.some((c) => c.id === id);
      return {
        activeId: id,
        conversations: known
          ? s.conversations.map((c) => (c.id === id ? result.conversation : c))
          : [result.conversation, ...s.conversations],
        messages: {
          ...s.messages,
          [id]: upsertMessage(
            upsertMessage(s.messages[id] ?? [], result.userMessage),
            result.assistantMessage,
          ),
        },
      };
    });
  },

  async cancel() {
    const { activeId } = get();
    if (activeId) await invoke('chat:cancel', { conversationId: activeId });
  },

  async setLanguage(id, language) {
    const updated = await invoke('chat:setLanguage', { conversationId: id, language });
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
  },

  async remove(id) {
    await invoke('chat:deleteConversation', { conversationId: id });
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  },

  async rename(id, title) {
    const updated = await invoke('chat:renameConversation', { conversationId: id, title });
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
  },

  applyDelta: (messageId, text) =>
    set((s) => ({
      streaming: { ...s.streaming, [messageId]: (s.streaming[messageId] ?? '') + text },
    })),

  applyFinished(message) {
    set((s) => {
      const { [message.id]: _dropped, ...streaming } = s.streaming;
      return {
        streaming,
        messages: {
          ...s.messages,
          [message.conversationId]: upsertMessage(
            s.messages[message.conversationId] ?? [],
            message,
          ),
        },
      };
    });
  },
}));
