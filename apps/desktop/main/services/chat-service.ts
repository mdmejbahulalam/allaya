import {
  estimateTokens,
  fitMessagesToBudget,
  type AIMessage,
  type AIRequest,
  type FinishReason,
  type ModelInfo,
} from '@allaya/ai';
import { buildSystemPrompt } from '@allaya/agent';
import type { ConversationRepository, ConversationRow, MessageRow } from '@allaya/database';
import {
  AllayaError,
  newId,
  toSerializedError,
  type Logger,
  type RunRegistry,
  type SerializedError,
} from '@allaya/shared';
import {
  z,
  type ConversationView,
  type MessageView,
  type ModelRefView,
  serializedErrorSchema,
} from '@allaya/validation';
import type { EventPublisher } from '../ipc/events';
import type { ProviderService } from './provider-service';
import type { SettingsService } from './settings-service';

/** Persisted in `messages.metadata_json` for assistant messages. */
const assistantMetadataSchema = z.object({
  status: z.enum(['streaming', 'complete', 'error', 'cancelled']),
  model: z
    .object({ providerId: z.string(), modelId: z.string(), displayName: z.string() })
    .optional(),
  routeReason: z.string().optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  finishReason: z.string().optional(),
  error: serializedErrorSchema.optional(),
});
type AssistantMetadata = z.infer<typeof assistantMetadataSchema>;

const TITLE_MAX = 60;
const DELTA_FLUSH_MS = 30;
const DEFAULT_MAX_OUTPUT = 4096;
/** History is trimmed to leave this much of the window for the reply and the system prompt. */
const CONTEXT_SAFETY_MARGIN = 2048;

export function titleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  // Slice by code points so a Bengali conjunct or emoji is never split in half.
  const chars = Array.from(oneLine);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : oneLine;
}

export interface ChatServiceDeps {
  conversations: ConversationRepository;
  providers: ProviderService;
  settings: SettingsService;
  events: EventPublisher;
  runs: RunRegistry;
  logger: Logger;
  now?: () => Date;
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  // ── queries ───────────────────────────────────────────────────────────────
  listConversations(): ConversationView[] {
    return this.deps.conversations.list().map(toConversationView);
  }

  getMessages(conversationId: string): MessageView[] {
    this.requireConversation(conversationId);
    return this.deps.conversations.listMessages(conversationId).map(toMessageView);
  }

  // ── commands ──────────────────────────────────────────────────────────────
  renameConversation(conversationId: string, title: string): ConversationView {
    this.requireConversation(conversationId);
    this.deps.conversations.rename(conversationId, title);
    this.deps.events.publish('chat:conversationsChanged', {});
    return toConversationView(this.requireConversation(conversationId));
  }

  deleteConversation(conversationId: string): boolean {
    if (!this.deps.conversations.get(conversationId)) return false;
    this.deps.runs.cancel(runId(conversationId), 'conversation deleted');
    this.deps.conversations.softDelete(conversationId);
    this.deps.events.publish('chat:conversationsChanged', {});
    return true;
  }

  cancel(conversationId: string): boolean {
    return this.deps.runs.cancel(runId(conversationId), 'cancelled by user');
  }

  /**
   * Persists the user message and an assistant placeholder, then generates in the background.
   * Returns immediately so the UI can render both bubbles; progress arrives as `chat:delta` / `chat:finished`.
   */
  send(input: {
    conversationId?: string | undefined;
    text: string;
    model?: ModelRefView | undefined;
  }): {
    conversation: ConversationView;
    userMessage: MessageView;
    assistantMessage: MessageView;
  } {
    const { conversations } = this.deps;
    const conversation = input.conversationId
      ? this.requireConversation(input.conversationId)
      : conversations.create(newId('conv'), titleFromText(input.text));

    if (this.deps.runs.isActive(runId(conversation.id))) {
      throw new AllayaError('Allaya is still replying in this conversation', { code: 'CONFLICT' });
    }

    const userRow = conversations.addMessage({
      id: newId('msg'),
      conversationId: conversation.id,
      kind: 'user',
      content: input.text,
    });
    const assistantRow = conversations.addMessage({
      id: newId('msg'),
      conversationId: conversation.id,
      kind: 'assistant',
      content: '',
      metadata: { status: 'streaming' } satisfies AssistantMetadata,
    });
    this.deps.events.publish('chat:conversationsChanged', {});

    // Fire and forget: every failure path inside `generate` is turned into a persisted, published error state.
    void this.generate(conversation.id, assistantRow.id, input.model);

    return {
      conversation: toConversationView(this.requireConversation(conversation.id)),
      userMessage: toMessageView(userRow),
      assistantMessage: toMessageView(assistantRow),
    };
  }

  /** Startup housekeeping: a crash mid-stream leaves messages 'streaming' forever — mark them interrupted. */
  recoverInterrupted(): number {
    let recovered = 0;
    for (const conversation of this.deps.conversations.list(1000)) {
      for (const row of this.deps.conversations.listMessages(conversation.id)) {
        if (row.kind !== 'assistant') continue;
        const metadata = parseAssistantMetadata(row.metadataJson);
        if (metadata?.status !== 'streaming') continue;
        const error: SerializedError = {
          code: 'CANCELLED',
          message: 'Interrupted when Allaya closed',
          retryable: true,
        };
        this.deps.conversations.updateMessage(row.id, {
          metadata: { ...metadata, status: 'error', error },
        });
        recovered += 1;
      }
    }
    return recovered;
  }

  // ── generation ────────────────────────────────────────────────────────────
  private async generate(
    conversationId: string,
    assistantId: string,
    pinned: ModelRefView | undefined,
  ): Promise<void> {
    const { conversations, providers, runs, events, logger } = this.deps;
    const source = runs.start(runId(conversationId), 'chat');
    this.publishStatus('thinking');

    let text = '';
    let metadata: AssistantMetadata = { status: 'streaming' };
    let pendingDelta = '';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (pendingDelta) {
        events.publish('chat:delta', {
          conversationId,
          messageId: assistantId,
          text: pendingDelta,
        });
        pendingDelta = '';
      }
    };

    try {
      const history = this.buildHistory(conversationId, assistantId);
      const estimatedInput = history.reduce(
        (n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : ''),
        0,
      );
      const decision = providers.router.select({
        purpose: 'general',
        // Message length says little about difficulty, so plain chat routes to the balanced tier rather than
        // "fast" (small models are noticeably weaker in Bengali). Real task-complexity classification arrives
        // with the agent planner; only genuinely large prompts are escalated here.
        ...(estimatedInput > 6000 ? { complexity: 'multi_step' as const } : {}),
        estimatedInputTokens: estimatedInput,
        ...(pinned ? { pinned } : {}),
      });
      const model = decision.model;
      metadata = {
        status: 'streaming',
        model: {
          providerId: model.providerId,
          modelId: model.modelId,
          displayName: model.displayName,
        },
        routeReason: decision.reason,
      };
      conversations.updateMessage(assistantId, { metadata });

      const request = this.buildRequest(model, history);
      this.publishStatus('working', model.displayName);
      let finishReason: FinishReason = 'stop';

      for await (const event of providers
        .provider(model.providerId)
        .stream(request, source.signal)) {
        if (event.type === 'text_delta') {
          text += event.text;
          pendingDelta += event.text;
          flushTimer ??= setTimeout(flush, DELTA_FLUSH_MS);
        } else if (event.type === 'usage') {
          const usage = {
            inputTokens: event.usage.inputTokens ?? metadata.usage?.inputTokens ?? 0,
            outputTokens: event.usage.outputTokens ?? metadata.usage?.outputTokens ?? 0,
          };
          metadata = { ...metadata, usage };
        } else if (event.type === 'finish') {
          finishReason = event.reason;
        }
      }
      flush();
      metadata = { ...metadata, status: 'complete', finishReason };
      this.publishStatus('completed');
    } catch (error) {
      flush();
      const serialized = toSerializedError(error);
      if (serialized.code === 'CANCELLED') {
        metadata = { ...metadata, status: 'cancelled' };
        this.publishStatus('paused', 'Stopped');
      } else {
        logger.warn('Chat generation failed', { code: serialized.code });
        metadata = { ...metadata, status: 'error', error: serialized };
        this.publishStatus('failed');
      }
    } finally {
      runs.finish(runId(conversationId));
      conversations.updateMessage(assistantId, { content: text, metadata });
      conversations.touch(conversationId);
      const row = conversations.getMessage(assistantId);
      if (row) events.publish('chat:finished', { conversationId, message: toMessageView(row) });
      events.publish('chat:conversationsChanged', {});
      // Return the status pill to "ready" shortly after showing the outcome.
      setTimeout(() => {
        if (runs.active().length === 0) this.publishStatus('ready');
      }, 2500).unref?.();
    }
  }

  private buildHistory(conversationId: string, excludeMessageId: string): AIMessage[] {
    return this.deps.conversations
      .listMessages(conversationId)
      .filter((row) => row.id !== excludeMessageId)
      .filter((row) => {
        if (row.kind === 'user') return true;
        // Failed or empty assistant turns are omitted so they never poison the next request.
        const meta = parseAssistantMetadata(row.metadataJson);
        return row.kind === 'assistant' && row.content.trim() !== '' && meta?.status !== 'error';
      })
      .map((row): AIMessage => ({
        role: row.kind === 'user' ? 'user' : 'assistant',
        content: row.content,
      }));
  }

  private buildRequest(model: ModelInfo, history: AIMessage[]): AIRequest {
    const { settings, now } = this.deps;
    const system = buildSystemPrompt({
      responseLanguage: settings.get('language.response'),
      userName: settings.get('profile.displayName'),
      toolsAvailable: false,
      now: (now ?? (() => new Date()))(),
    });
    const maxOutput = Math.min(
      model.capabilities.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
      DEFAULT_MAX_OUTPUT,
    );
    const budget = Math.max(
      1000,
      model.capabilities.contextWindow - maxOutput - estimateTokens(system) - CONTEXT_SAFETY_MARGIN,
    );
    const fitted = fitMessagesToBudget(history, budget);
    return { model: model.modelId, system, messages: fitted.messages, maxTokens: maxOutput };
  }

  private publishStatus(
    status: 'thinking' | 'working' | 'completed' | 'failed' | 'paused' | 'ready',
    detail?: string,
  ): void {
    this.deps.events.publish('agent:status', {
      status,
      ...(detail ? { detail } : {}),
      activeRuns: this.deps.runs.active().length,
    });
  }

  private requireConversation(id: string): ConversationRow {
    const row = this.deps.conversations.get(id);
    if (!row) throw new AllayaError('Conversation not found', { code: 'NOT_FOUND' });
    return row;
  }
}

const runId = (conversationId: string) => `chat:${conversationId}`;

function parseAssistantMetadata(json: string | null): AssistantMetadata | undefined {
  if (!json) return undefined;
  try {
    const parsed = assistantMetadataSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function toConversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMessageView(row: MessageRow): MessageView {
  const base = {
    id: row.id,
    conversationId: row.conversationId,
    content: row.content,
    createdAt: row.createdAt,
  };
  if (row.kind !== 'assistant') return { ...base, kind: 'user' };
  const meta = parseAssistantMetadata(row.metadataJson);
  return {
    ...base,
    kind: 'assistant',
    status: meta?.status ?? 'complete',
    ...(meta?.model ? { model: meta.model } : {}),
    ...(meta?.routeReason ? { routeReason: meta.routeReason } : {}),
    ...(meta?.usage ? { usage: meta.usage } : {}),
    ...(meta?.error ? { error: meta.error } : {}),
  };
}
