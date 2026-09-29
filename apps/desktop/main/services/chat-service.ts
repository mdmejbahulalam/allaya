import {
  estimateTokens,
  fitMessagesToBudget,
  type AIMessage,
  type AIRequest,
  type FinishReason,
  type ModelInfo,
  type ToolCall,
  type ToolResultPart,
} from '@allaya/ai';
import { buildSystemPrompt } from '@allaya/agent';
import { MEMORY_TOOL_RULE } from '@allaya/memory';
import {
  MIN_DETECTION_CONFIDENCE,
  LanguageSession,
  detectLanguage,
  interpret,
  parseAnswer,
  reply as localReply,
  type LanguageAnalysis,
  type ParsedIntent,
  type ResolvedResponseLanguage,
} from '@allaya/language';
import { resolveUiLocale } from '@allaya/localization';
import {
  formatResultForModel,
  type ConfirmationRequest,
  type ExecutionProgress,
  type ModelToolSpec,
} from '@allaya/tools';
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
  actionRecordSchema,
  type ActionRecord,
  type ConversationView,
  type MessageView,
  type ModelRefView,
  serializedErrorSchema,
  MAX_TASK_REQUEST_CHARS,
} from '@allaya/validation';
import type { EventPublisher } from '../ipc/events';
import type { ProviderService } from './provider-service';
import type { SettingsService } from './settings-service';
import type { ToolService } from './tool-service';
import { titleFromText } from './text';

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
  /** Set when Allaya answered on its own (no model call): a language switch or a stop/cancel command. */
  local: z.enum(['language', 'stop', 'cancel', 'confirmation', 'task']).optional(),
  /** What Allaya did on the computer while producing this reply. */
  actions: z.array(actionRecordSchema).optional(),
  /** The memories this reply was given. */
  memories: z
    .array(z.object({ id: z.string(), key: z.string() }))
    .max(20)
    .optional(),
});
type AssistantMetadata = z.infer<typeof assistantMetadataSchema>;

/** Persisted in `messages.metadata_json` for user messages: what language detection made of the text. */
const userMetadataSchema = z.object({
  detected: z.object({ primary: z.enum(['bn', 'en']), confidence: z.number() }).optional(),
});

/** Control commands are short; longer text is never treated as one, however it parses. */
const CONTROL_MAX_CHARS = 80;

/** Upper bounds on one reply's tool use: a model that loops must not run away with the computer. */
const MAX_TOOL_ROUNDS = 8;
const MAX_CALLS_PER_ROUND = 8;

const DELTA_FLUSH_MS = 30;
const DEFAULT_MAX_OUTPUT = 4096;
/** History is trimmed to leave this much of the window for the reply and the system prompt. */
const CONTEXT_SAFETY_MARGIN = 2048;

export { titleFromText };

/** What chat needs from the task engine. */
export interface TaskChatPort {
  create(input: {
    request: string;
    conversationId: string;
    language: 'bn' | 'en';
    source: 'chat';
    complexity: 'multi_step';
    planFirst?: boolean | undefined;
  }): { id: string; title: string };
  /** A message in a conversation where a task is waiting: its answer, or a yes/no. `undefined` if it is not for the task. */
  answerFromChat(conversationId: string, text: string): string | undefined;
  /** "Cancel" in a conversation also stops the task it started. */
  cancelForConversation(conversationId: string): boolean;
}

/**
 * The one tool that is not a computer action: hand a multi-step request to the task engine. It is handled here
 * (not in the tool pipeline) because it starts a run rather than acting on the computer — everything the task then
 * does still goes through the pipeline.
 */
export const START_TASK_TOOL = 'start_task';

const startTaskSchema = z.object({
  request: z.string().trim().min(1).max(MAX_TASK_REQUEST_CHARS),
  plan_first: z.boolean().optional(),
});

const startTaskSpec = (): ModelToolSpec => ({
  name: START_TASK_TOOL,
  description:
    'Starts a background task for a request that needs several steps or will take a while (for example "find the ' +
    'newest invoice, move it to Documents, then open it"). Pass the user\'s request in their own words. The task ' +
    'plans, does the work with the same tools and permissions, checks the results, and posts the outcome here when ' +
    'it is done. For one quick action, use that tool directly instead. Set plan_first to true if the user wants to ' +
    'see the plan before anything is done.',
  inputSchema: {
    type: 'object',
    properties: {
      request: { type: 'string', description: 'What the user asked for, in their own words.' },
      plan_first: { type: 'boolean', description: 'Show the plan and wait for approval first.' },
    },
    required: ['request'],
  },
});

export interface ChatServiceDeps {
  conversations: ConversationRepository;
  providers: ProviderService;
  settings: SettingsService;
  tools: ToolService;
  /** The task engine. Omitted in tests that do not use it (then the model is not offered `start_task`). */
  tasks?: TaskChatPort;
  /** What Allaya remembers. Omitted in tests that do not use it (then nothing is added to the prompt). */
  memory?: {
    forPrompt(query: string): {
      text?: string | undefined;
      used: Array<{ id: string; key: string }>;
    };
  };
  events: EventPublisher;
  runs: RunRegistry;
  logger: Logger;
  now?: () => Date;
  /** The OS locale, used to pick a reply language when nothing else is known ("auto" UI language). */
  osLocale?: () => string;
}

interface SendResult {
  conversation: ConversationView;
  userMessage: MessageView;
  assistantMessage: MessageView;
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
    source?: 'text' | 'voice' | undefined;
  }): SendResult {
    const { conversations, runs } = this.deps;
    const conversation = input.conversationId
      ? this.requireConversation(input.conversationId)
      : conversations.create(newId('conv'), titleFromText(input.text));

    const analysis = detectLanguage(input.text);
    const session = this.sessionFor(conversation);
    const control = this.controlIntent(input.text);
    const active = runs.isActive(runId(conversation.id));

    // "stop" must work while Allaya is busy, so it is checked before the busy-conversation guard.
    if (control && (control.type !== 'SWITCH_LANGUAGE' || !active)) {
      return this.answerLocally(conversation, input.text, analysis, session, control);
    }
    // A question from Allaya is waiting ("Delete 3 files?"): a plain yes/no in chat or by voice answers it.
    const waiting = this.deps.tools.pendingFor(conversation.id)[0];
    if (waiting) {
      const handled = this.answerConfirmation(conversation, input, analysis, session, waiting);
      if (handled) return handled;
    }
    // A task from this conversation is waiting for an answer or a yes/no: this message may be it.
    const taskReply = this.deps.tasks?.answerFromChat(conversation.id, input.text);
    if (taskReply !== undefined) {
      return this.replyLocally(conversation, input.text, analysis, taskReply, 'task');
    }
    if (active) {
      throw new AllayaError('Allaya is still replying in this conversation', { code: 'CONFLICT' });
    }

    const userRow = conversations.addMessage({
      id: newId('msg'),
      conversationId: conversation.id,
      kind: 'user',
      content: input.text,
      language: analysis.language,
      metadata: userMetadata(analysis),
    });
    const assistantRow = conversations.addMessage({
      id: newId('msg'),
      conversationId: conversation.id,
      kind: 'assistant',
      content: '',
      metadata: { status: 'streaming' } satisfies AssistantMetadata,
    });
    this.deps.events.publish('chat:conversationsChanged', {});

    const replyLanguage = session.resolve(
      this.deps.settings.get('language.response'),
      analysis,
      this.uiLanguage(),
    );

    // Fire and forget: every failure path inside `generate` is turned into a persisted, published error state.
    void this.generate(conversation.id, assistantRow.id, input.model, replyLanguage);

    return {
      conversation: toConversationView(this.requireConversation(conversation.id)),
      userMessage: toMessageView(userRow),
      assistantMessage: toMessageView(assistantRow),
    };
  }

  /** Changes (or clears, with `auto`) the reply language for one conversation. */
  setLanguage(conversationId: string, language: 'auto' | 'bn' | 'en'): ConversationView {
    this.requireConversation(conversationId);
    this.deps.conversations.setLanguage(conversationId, language === 'auto' ? null : language);
    this.deps.events.publish('chat:conversationsChanged', {});
    return toConversationView(this.requireConversation(conversationId));
  }

  // ── deterministic control commands ────────────────────────────────────────
  /**
   * A message that is *entirely* a stop / cancel / language-switch command. Anything longer, ambiguous or with
   * extra content falls through to the model — a control word buried in a sentence never triggers an action.
   */
  private controlIntent(text: string): ParsedIntent | undefined {
    if (text.length > CONTROL_MAX_CHARS) return undefined;
    const now = (this.deps.now ?? (() => new Date()))();
    const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
    const result = interpret(text, {}, { today });
    const [clause] = result.clauses;
    if (result.needsPlanner || result.clauses.length !== 1 || !clause) return undefined;
    return clause.type === 'STOP' || clause.type === 'CANCEL' || clause.type === 'SWITCH_LANGUAGE'
      ? clause
      : undefined;
  }

  private answerLocally(
    conversation: ConversationRow,
    text: string,
    analysis: LanguageAnalysis,
    session: LanguageSession,
    intent: ParsedIntent,
  ): SendResult {
    const { conversations, runs } = this.deps;
    let content: string;
    let local: NonNullable<AssistantMetadata['local']>;
    if (intent.type === 'SWITCH_LANGUAGE') {
      const target = intent.params.language ?? 'en';
      conversations.setLanguage(conversation.id, target);
      content = localReply(target === 'bn' ? 'languageSwitchedBn' : 'languageSwitchedEn', target);
      local = 'language';
    } else {
      const language = this.replyLanguageCode(session, analysis);
      if (intent.type === 'STOP') {
        // A typed "stop" means stop everything, exactly like the emergency stop.
        const stopped = runs.cancelAll('stop command');
        content = localReply(stopped > 0 ? 'stopped' : 'nothingRunning', language, stopped);
        local = 'stop';
      } else {
        const cancelled =
          runs.cancel(runId(conversation.id), 'cancelled by user') ||
          (this.deps.tasks?.cancelForConversation(conversation.id) ?? false);
        content = localReply(cancelled ? 'cancelled' : 'nothingToCancel', language);
        local = 'cancel';
      }
    }
    return this.replyLocally(conversation, text, analysis, content, local);
  }

  /**
   * Handles a reply to a pending confirmation. Only an unambiguous yes/no counts (`parseAnswer`); anything else
   * re-shows the question. Returns `undefined` when the question was already settled, so the message is treated
   * as ordinary input instead of being swallowed.
   */
  private answerConfirmation(
    conversation: ConversationRow,
    input: { text: string; source?: 'text' | 'voice' | undefined },
    analysis: LanguageAnalysis,
    session: LanguageSession,
    waiting: ConfirmationRequest,
  ): SendResult | undefined {
    const language = this.replyLanguageCode(session, analysis);
    const answer = parseAnswer(input.text);
    let content: string;
    if (answer === 'unclear') {
      content = localReply('confirmationWaiting', language, waiting.summary);
    } else {
      const channel = input.source === 'voice' ? 'voice' : 'text';
      const result = this.deps.tools.respond(
        waiting.id,
        answer === 'yes' ? 'approved' : 'rejected',
        channel,
      );
      if (!result.ok && result.reason === 'unknown') return undefined; // settled in the meantime
      content = result.ok
        ? localReply(answer === 'yes' ? 'confirmationApproved' : 'confirmationRejected', language)
        : localReply('confirmationNeedsScreen', language);
    }
    return this.replyLocally(conversation, input.text, analysis, content, 'confirmation');
  }

  private replyLanguageCode(session: LanguageSession, analysis: LanguageAnalysis): 'bn' | 'en' {
    const resolved = session.resolve(
      this.deps.settings.get('language.response'),
      analysis,
      this.uiLanguage(),
    );
    return resolved.language === 'en' ? 'en' : 'bn';
  }

  /** Persists a user message and a ready-made assistant reply that involved no model call. */
  private replyLocally(
    conversation: ConversationRow,
    text: string,
    analysis: LanguageAnalysis,
    content: string,
    local: NonNullable<AssistantMetadata['local']>,
  ): SendResult {
    const { conversations, events } = this.deps;
    const userRow = conversations.addMessage({
      id: newId('msg'),
      conversationId: conversation.id,
      kind: 'user',
      content: text,
      language: analysis.language,
      metadata: userMetadata(analysis),
    });
    const assistantRow = conversations.addMessage({
      id: newId('msg'),
      conversationId: conversation.id,
      kind: 'assistant',
      content,
      metadata: { status: 'complete', local } satisfies AssistantMetadata,
    });
    conversations.touch(conversation.id);
    events.publish('chat:conversationsChanged', {});
    return {
      conversation: toConversationView(this.requireConversation(conversation.id)),
      userMessage: toMessageView(userRow),
      assistantMessage: toMessageView(assistantRow),
    };
  }

  /** Rebuilds the conversation's language memory from what was persisted. */
  private sessionFor(conversation: ConversationRow): LanguageSession {
    const explicit =
      conversation.language === 'bn' || conversation.language === 'en'
        ? conversation.language
        : null;
    let last: 'bn' | 'en' | null = null;
    const rows = this.deps.conversations.listMessages(conversation.id);
    for (let i = rows.length - 1; i >= 0 && last === null; i -= 1) {
      const row = rows[i]!;
      if (row.kind !== 'user') continue;
      const detected = parseUserMetadata(row.metadataJson)?.detected;
      if (detected && detected.confidence >= MIN_DETECTION_CONFIDENCE) last = detected.primary;
    }
    return LanguageSession.restore({ explicit, last });
  }

  private uiLanguage(): 'bn' | 'en' {
    const preference = this.deps.settings.get('language.ui');
    return resolveUiLocale(preference, this.deps.osLocale?.()) === 'bn' ? 'bn' : 'en';
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
    replyLanguage: ResolvedResponseLanguage,
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
        // Prefer a model that can use the tools — unless the user picked one, which is always honoured.
        ...(!pinned &&
        this.deps.tools.hasTools() &&
        providers.availableModels().some((m) => m.capabilities.tools)
          ? { needsTools: true }
          : {}),
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

      // What Allaya remembers that bears on this message — worked out once per reply, and recorded on the reply so
      // the person can see what shaped it.
      const asked = [...history].reverse().find((m) => m.role === 'user');
      const memoryUse = this.deps.memory?.forPrompt(
        typeof asked?.content === 'string' ? asked.content : '',
      ) ?? { used: [] };
      if (memoryUse.used.length > 0) {
        metadata = { ...metadata, memories: memoryUse.used };
        conversations.updateMessage(assistantId, { metadata });
      }

      const { tools } = this.deps;
      // Tools are offered only to a model that can use them, and only if any are registered.
      const canStartTasks = this.deps.tasks !== undefined && model.capabilities.tools;
      const modelTools =
        tools.hasTools() && model.capabilities.tools
          ? [...tools.modelTools(), ...(canStartTasks ? [startTaskSpec()] : [])]
          : undefined;
      let startedTask = false;
      const toolLanguage = replyLanguage.language === 'en' ? 'en' : 'bn';
      const messages: AIMessage[] = [...history];
      const actions: ActionRecord[] = [];
      let usage = { inputTokens: 0, outputTokens: 0 };
      let limitHit = false;
      this.publishStatus('working', model.displayName);
      let finishReason: FinishReason = 'stop';

      const upsertAction = (action: ActionRecord) => {
        const index = actions.findIndex((a) => a.callId === action.callId);
        if (index === -1) actions.push(action);
        else actions[index] = { ...actions[index]!, ...action };
        metadata = { ...metadata, actions: [...actions] };
        conversations.updateMessage(assistantId, { metadata });
        events.publish('tools:activity', {
          conversationId,
          messageId: assistantId,
          action: actions[index === -1 ? actions.length - 1 : index]!,
        });
      };

      for (let round = 0; ; round += 1) {
        const request = this.buildRequest(
          model,
          messages,
          replyLanguage,
          modelTools,
          canStartTasks,
          {
            memory: memoryUse.text,
            canRemember: modelTools?.some((t) => t.name === 'remember') ?? false,
          },
        );
        const calls: ToolCall[] = [];
        let roundText = '';
        let roundUsage = { inputTokens: 0, outputTokens: 0 };
        finishReason = 'stop';

        for await (const event of providers
          .provider(model.providerId)
          .stream(request, source.signal)) {
          if (event.type === 'text_delta') {
            // A new step's text is set apart from the previous one ("Let me check." / "It is 5 pm.").
            const piece =
              round > 0 && roundText === '' && text && !text.endsWith('\n')
                ? `\n\n${event.text}`
                : event.text;
            roundText += event.text;
            text += piece;
            pendingDelta += piece;
            flushTimer ??= setTimeout(flush, DELTA_FLUSH_MS);
          } else if (event.type === 'tool_call') {
            calls.push(event.call);
          } else if (event.type === 'usage') {
            roundUsage = {
              inputTokens: event.usage.inputTokens ?? roundUsage.inputTokens,
              outputTokens: event.usage.outputTokens ?? roundUsage.outputTokens,
            };
            metadata = {
              ...metadata,
              usage: {
                inputTokens: usage.inputTokens + roundUsage.inputTokens,
                outputTokens: usage.outputTokens + roundUsage.outputTokens,
              },
            };
          } else if (event.type === 'finish') {
            finishReason = event.reason;
          }
        }
        usage = {
          inputTokens: usage.inputTokens + roundUsage.inputTokens,
          outputTokens: usage.outputTokens + roundUsage.outputTokens,
        };

        // Only a completed tool-use turn is acted on: a reply cut off by the length limit never runs half a request.
        if (calls.length === 0 || finishReason !== 'tool_calls') break;
        if (round >= MAX_TOOL_ROUNDS) {
          limitHit = true;
          break;
        }

        messages.push({
          role: 'assistant',
          content: [
            ...(roundText ? [{ type: 'text' as const, text: roundText }] : []),
            ...calls.map((call) => ({
              type: 'tool_call' as const,
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          ],
        });
        const results: ToolResultPart[] = [];
        for (const [index, call] of calls.entries()) {
          if (source.signal.aborted) throw new AllayaError('cancelled', { code: 'CANCELLED' });
          if (index >= MAX_CALLS_PER_ROUND) {
            results.push({
              type: 'tool_result',
              toolCallId: call.id,
              content: JSON.stringify({
                ok: false,
                error: 'Too many tool calls at once. Do them one step at a time.',
              }),
              isError: true,
            });
            continue;
          }
          if (call.name === START_TASK_TOOL && canStartTasks) {
            const started = this.startTask(conversationId, call, toolLanguage, startedTask);
            if (started.action) upsertAction(started.action);
            if (started.ok) startedTask = true;
            results.push({
              type: 'tool_result',
              toolCallId: call.id,
              content: started.content,
              isError: !started.ok,
            });
            continue;
          }
          const result = await tools.execute(
            { id: newId('call'), name: call.name, arguments: call.arguments },
            {
              signal: source.signal,
              language: toolLanguage,
              conversationId,
              onProgress: (progress) => upsertAction(toActionRecord(progress)),
            },
          );
          const formatted = formatResultForModel(result);
          results.push({
            type: 'tool_result',
            toolCallId: call.id,
            content: formatted.content,
            isError: formatted.isError,
          });
        }
        messages.push({ role: 'user', content: results });
        if (source.signal.aborted) throw new AllayaError('cancelled', { code: 'CANCELLED' });
      }
      if (limitHit) {
        const note = `\n\n${localReply('toolLimit', toolLanguage, MAX_TOOL_ROUNDS)}`;
        text += note;
        pendingDelta += note;
      }
      flush();
      metadata = {
        ...metadata,
        usage,
        status: 'complete',
        finishReason: limitHit ? 'length' : finishReason,
      };
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

  /** Hands a request to the task engine. One task per reply; the model is told plainly what did and did not happen. */
  private startTask(
    conversationId: string,
    call: ToolCall,
    language: 'bn' | 'en',
    alreadyStarted: boolean,
  ): { ok: boolean; content: string; action?: ActionRecord } {
    const fail = (error: string) => ({ ok: false, content: JSON.stringify({ ok: false, error }) });
    const parsed = startTaskSchema.safeParse(call.arguments);
    if (!parsed.success) return fail('start_task needs the request as text.');
    if (alreadyStarted) return fail('A task was already started for this message.');
    try {
      const task = this.deps.tasks!.create({
        request: parsed.data.request,
        conversationId,
        language,
        source: 'chat',
        complexity: 'multi_step',
        planFirst: parsed.data.plan_first,
      });
      const summary =
        language === 'bn' ? `টাস্ক শুরু হয়েছে: ${task.title}` : `Started a task: ${task.title}`;
      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          taskId: task.id,
          note:
            'The task was started and runs in the background. Tell the user in one short sentence that you started ' +
            'it and that the result will be posted here when it is done. Do not say anything is done yet.',
        }),
        action: {
          callId: call.id,
          tool: START_TASK_TOOL,
          summary,
          status: 'success',
          verification: 'not_applicable',
        },
      };
    } catch (error) {
      const message = toSerializedError(error).message;
      return fail(`The task could not be started: ${message}`);
    }
  }

  private buildRequest(
    model: ModelInfo,
    history: AIMessage[],
    replyLanguage: ResolvedResponseLanguage,
    tools?: ModelToolSpec[],
    canStartTasks = false,
    extras: { memory?: string | undefined; canRemember?: boolean } = {},
  ): AIRequest {
    const { settings, now } = this.deps;
    const system = buildSystemPrompt({
      responseLanguage: settings.get('language.response'),
      reply: replyLanguage,
      userName: settings.get('profile.displayName'),
      toolsAvailable: tools !== undefined && tools.length > 0,
      canStartTasks,
      ...(extras.memory ? { memory: extras.memory } : {}),
      ...(extras.canRemember ? { memoryRule: MEMORY_TOOL_RULE } : {}),
      now: (now ?? (() => new Date()))(),
    });
    const maxOutput = Math.min(
      model.capabilities.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
      DEFAULT_MAX_OUTPUT,
    );
    const toolTokens = tools ? estimateTokens(JSON.stringify(tools)) : 0;
    const budget = Math.max(
      1000,
      model.capabilities.contextWindow -
        maxOutput -
        estimateTokens(system) -
        toolTokens -
        CONTEXT_SAFETY_MARGIN,
    );
    const fitted = fitMessagesToBudget(history, budget);
    return {
      model: model.modelId,
      system,
      messages: fitted.messages,
      maxTokens: maxOutput,
      ...(tools && tools.length > 0 ? { tools, toolChoice: 'auto' as const } : {}),
    };
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

/** Maps engine progress to the compact record shown in (and saved with) a reply. */
function toActionRecord(progress: ExecutionProgress): ActionRecord {
  switch (progress.type) {
    case 'started':
      return {
        callId: progress.callId,
        tool: progress.tool,
        summary: progress.summary,
        status: 'running',
        risk: progress.risk,
      };
    case 'awaiting_confirmation':
      return {
        callId: progress.callId,
        tool: progress.tool,
        summary: progress.summary,
        status: 'awaiting_confirmation',
        risk: progress.risk,
      };
    case 'running':
      return { callId: progress.callId, tool: progress.tool, summary: '', status: 'running' };
    case 'finished': {
      const { result } = progress;
      return {
        callId: result.callId,
        tool: result.tool,
        summary: result.summary,
        status: result.status,
        ...(result.risk ? { risk: result.risk } : {}),
        verification: result.verification,
        ...(result.evidence ? { evidence: result.evidence } : {}),
        ...(result.error ? { error: result.error.message } : {}),
      };
    }
  }
}

function userMetadata(analysis: LanguageAnalysis) {
  return {
    detected: { primary: analysis.primary, confidence: analysis.confidence },
  } satisfies z.infer<typeof userMetadataSchema>;
}

function parseUserMetadata(json: string | null): z.infer<typeof userMetadataSchema> | undefined {
  if (!json) return undefined;
  try {
    const parsed = userMetadataSchema.safeParse(JSON.parse(json));
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
    language: row.language === 'bn' || row.language === 'en' ? row.language : null,
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
    ...(meta?.actions?.length ? { actions: meta.actions } : {}),
    ...(meta?.memories?.length ? { memoriesUsed: meta.memories } : {}),
    ...(row.taskId ? { taskId: row.taskId } : {}),
  };
}
