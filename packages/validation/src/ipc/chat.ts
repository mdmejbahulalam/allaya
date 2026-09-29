import { z } from 'zod';
import { serializedErrorSchema, spec, noPayload, idSchema } from './common';
import { modelRefSchema } from './providers';
import { actionRecordSchema } from './tools';

export const conversationViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  /** The reply language the user asked for in this conversation; `null` follows the language they write in. */
  language: z.enum(['bn', 'en']).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ConversationView = z.infer<typeof conversationViewSchema>;

export const messageViewSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.number(),
  /** Assistant messages only. */
  status: z.enum(['streaming', 'complete', 'error', 'cancelled']).optional(),
  model: z
    .object({ providerId: z.string(), modelId: z.string(), displayName: z.string() })
    .optional(),
  routeReason: z.string().optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  error: serializedErrorSchema.optional(),
  /** What Allaya did on the computer while producing this reply, in order. */
  actions: z.array(actionRecordSchema).optional(),
  /** The task this message reports on, when it does (opens the Tasks screen). */
  taskId: z.string().optional(),
});
export type MessageView = z.infer<typeof messageViewSchema>;

export const MAX_MESSAGE_CHARS = 20_000;

export const chatContract = {
  invoke: {
    'chat:listConversations': spec(noPayload, z.array(conversationViewSchema)),
    'chat:getMessages': spec(z.object({ conversationId: idSchema }), z.array(messageViewSchema)),
    'chat:send': spec(
      z.object({
        conversationId: idSchema.optional(),
        text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
        /** How the text was entered. A spoken "yes" cannot approve the most dangerous actions. */
        source: z.enum(['text', 'voice']).optional(),
        /** Explicit per-message model choice; omit for automatic/assigned routing. */
        model: modelRefSchema.optional(),
      }),
      z.object({
        conversation: conversationViewSchema,
        userMessage: messageViewSchema,
        assistantMessage: messageViewSchema,
      }),
    ),
    'chat:setLanguage': spec(
      z.object({ conversationId: idSchema, language: z.enum(['auto', 'bn', 'en']) }),
      conversationViewSchema,
    ),
    'chat:cancel': spec(
      z.object({ conversationId: idSchema }),
      z.object({ cancelled: z.boolean() }),
    ),
    'chat:renameConversation': spec(
      z.object({ conversationId: idSchema, title: z.string().trim().min(1).max(120) }),
      conversationViewSchema,
    ),
    'chat:deleteConversation': spec(
      z.object({ conversationId: idSchema }),
      z.object({ deleted: z.boolean() }),
    ),
  },
  events: {
    'chat:delta': z.object({ conversationId: z.string(), messageId: z.string(), text: z.string() }),
    'chat:finished': z.object({ conversationId: z.string(), message: messageViewSchema }),
    'chat:conversationsChanged': z.object({}),
  },
} as const;
