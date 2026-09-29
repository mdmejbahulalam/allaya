import type { HandlerRegistry } from '../registry';
import type { ChatService } from '../../services/chat-service';

export function registerChatHandlers(registry: HandlerRegistry, chat: ChatService): void {
  registry
    .register('chat:listConversations', () => chat.listConversations())
    .register('chat:getMessages', ({ conversationId }) => chat.getMessages(conversationId))
    .register('chat:send', (input) => chat.send(input))
    .register('chat:setLanguage', ({ conversationId, language }) =>
      chat.setLanguage(conversationId, language),
    )
    .register('chat:cancel', ({ conversationId }) => ({ cancelled: chat.cancel(conversationId) }))
    .register('chat:renameConversation', ({ conversationId, title }) =>
      chat.renameConversation(conversationId, title),
    )
    .register('chat:deleteConversation', ({ conversationId }) => ({
      deleted: chat.deleteConversation(conversationId),
    }));
}
