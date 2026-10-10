import { create } from 'zustand';
import type { ChatView, MessageView, ModelRef } from '../../../shared/ipc';
import { invoke } from '../lib/api';

interface ChatState {
  chats: ChatView[];
  /** The chat on screen; null is a new chat that has not been started. */
  activeId: string | null;
  messages: MessageView[];
  /** The model picked for a chat that has not been started yet. */
  pendingModel: ModelRef | null;
  loadChats: () => Promise<void>;
  open: (id: string) => Promise<void>;
  startNew: () => void;
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  chooseModel: (model: ModelRef) => Promise<void>;
  /** Event handlers (called by the app shell). */
  onDelta: (event: { chatId: string; messageId: string; text: string }) => void;
  onMessage: (message: MessageView) => void;
}

/**
 * A reply can start streaming before the answer to "send" has reached the screen (the engine does not wait). What
 * arrives for a message the screen does not have yet is kept here, in order, and applied the moment it appears.
 */
type Early = { delta: string } | { message: MessageView };
const early = new Map<string, Early[]>();
const EARLY_LIMIT = 50;

const keepEarly = (messageId: string, event: Early) => {
  const list = early.get(messageId) ?? [];
  list.push(event);
  early.set(messageId, list);
  if (early.size > EARLY_LIMIT) early.delete(early.keys().next().value!);
};

export const withEarly = (reply: MessageView): MessageView => {
  let out = reply;
  for (const event of early.get(reply.id) ?? []) {
    out = 'delta' in event ? { ...out, content: out.content + event.delta } : event.message;
  }
  early.delete(reply.id);
  return out;
};

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  activeId: null,
  messages: [],
  pendingModel: null,

  async loadChats() {
    set({ chats: await invoke('chats:list') });
  },

  async open(id) {
    const { chat, messages } = await invoke('chats:get', { id });
    set({ activeId: chat.id, messages });
  },

  startNew() {
    set({ activeId: null, messages: [], pendingModel: null });
  },

  async send(text) {
    const { activeId, pendingModel } = get();
    const sent = await invoke('chat:send', {
      text,
      ...(activeId ? { chatId: activeId } : {}),
      ...(!activeId && pendingModel ? { model: pendingModel } : {}),
    });
    set((s) => ({
      activeId: sent.chat.id,
      pendingModel: null,
      // A new chat starts with just these two; an open one adds them.
      messages: activeId
        ? [...s.messages, sent.userMessage, withEarly(sent.reply)]
        : [sent.userMessage, withEarly(sent.reply)],
    }));
    await get().loadChats();
  },

  async cancel() {
    const { activeId } = get();
    if (activeId) await invoke('chat:cancel', { chatId: activeId });
  },

  async remove(id) {
    await invoke('chats:remove', { id });
    if (get().activeId === id) get().startNew();
    await get().loadChats();
  },

  async chooseModel(model) {
    const { activeId } = get();
    if (!activeId) {
      set({ pendingModel: model });
      return;
    }
    await invoke('chats:setModel', { id: activeId, model });
    await get().loadChats();
  },

  onDelta({ chatId, messageId, text }) {
    const { activeId, messages } = get();
    if (activeId === null || (chatId === activeId && !messages.some((m) => m.id === messageId))) {
      keepEarly(messageId, { delta: text });
      return;
    }
    if (chatId !== activeId) return;
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, content: m.content + text } : m,
      ),
    }));
  },

  onMessage(message) {
    const { activeId, messages } = get();
    if (
      activeId === null ||
      (message.chatId === activeId && !messages.some((m) => m.id === message.id))
    ) {
      keepEarly(message.id, { message });
      return;
    }
    if (message.chatId !== activeId) return;
    set((s) => ({ messages: s.messages.map((m) => (m.id === message.id ? message : m)) }));
  },
}));

/** The model a chat will use now: its own, else the one picked for a new chat, else the default. */
export const currentModelRef = (
  chats: readonly ChatView[],
  activeId: string | null,
  pending: ModelRef | null,
  fallback: ModelRef | null,
): ModelRef | null =>
  (activeId ? chats.find((c) => c.id === activeId)?.model : undefined) ?? pending ?? fallback;
