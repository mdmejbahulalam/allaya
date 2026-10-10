import { randomBytes } from 'node:crypto';
import { fitMessagesToBudget, estimateTokens, type AIMessage } from '@allaya/ai';
import { AllayaError, nullLogger, toSerializedError, type Logger } from '@allaya/shared';
import type { ChatView, MessageView, ModelRef, Step } from '../../shared/ipc';
import { runAgent, type ApprovalRequest } from './agent';
import type { ConnectionService } from './connections';
import type { Db } from './db';
import type { Events } from './events';
import { buildSystemPrompt } from './prompt';
import type { SettingsStore } from './settings';
import type { ToolRegistry } from './tools';

interface ChatRow {
  id: string;
  title: string;
  model_json: string | null;
  created_at: number;
  updated_at: number;
}
interface MessageRow {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageView['status'];
  model: string | null;
  error_json: string | null;
  steps_json: string | null;
  created_at: number;
}

export interface ChatDeps {
  db: Db;
  connections: ConnectionService;
  settings: SettingsStore;
  events: Events;
  tools?: ToolRegistry;
  /** Asked before a tool that changes something outside Allaya runs. */
  approve?: (request: ApprovalRequest & { chatId: string }) => Promise<boolean>;
  logger?: Logger;
  now?: () => Date;
}

const DEFAULT_TITLE = 'New chat';
const TITLE_CHARS = 48;
/** How often a reply being written is saved, so a crash loses little. */
const SAVE_EVERY_MS = 1500;

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return Array.from(flat).length > max
    ? `${Array.from(flat).slice(0, max).join('').trim()}…`
    : flat;
};

function toChat(row: ChatRow): ChatView {
  return {
    id: row.id,
    title: row.title,
    model: row.model_json ? (JSON.parse(row.model_json) as ModelRef) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): MessageView {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    status: row.status,
    ...(row.model ? { model: row.model } : {}),
    ...(row.error_json
      ? { error: JSON.parse(row.error_json) as { code: string; message: string } }
      : {}),
    ...(row.steps_json ? { steps: JSON.parse(row.steps_json) as Step[] } : {}),
    createdAt: row.created_at,
  };
}

/**
 * Chats and their messages. Sending saves the person's message and an empty reply at once, hands them back, and
 * writes the reply in the background — streaming it to the screen as it arrives. A reply can be stopped; one
 * interrupted by closing the app is marked stopped, with whatever had been written kept.
 */
export class ChatService {
  private readonly logger: Logger;
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(private readonly deps: ChatDeps) {
    this.logger = deps.logger ?? nullLogger;
  }

  private now(): number {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  // ── reading ───────────────────────────────────────────────────────────────
  list(): ChatView[] {
    return (
      this.deps.db
        .prepare('select * from chats order by updated_at desc, rowid desc')
        .all() as ChatRow[]
    ).map(toChat);
  }

  private chatRow(id: string): ChatRow {
    const row = this.deps.db.prepare('select * from chats where id = ?').get(id) as
      ChatRow | undefined;
    if (!row) throw new AllayaError('That chat does not exist', { code: 'NOT_FOUND' });
    return row;
  }

  get(id: string): { chat: ChatView; messages: MessageView[] } {
    const chat = toChat(this.chatRow(id));
    const messages = (
      this.deps.db
        .prepare('select * from messages where chat_id = ? order by rowid')
        .all(id) as MessageRow[]
    ).map(toMessage);
    return { chat, messages };
  }

  private message(id: string): MessageView {
    const message = this.findMessage(id);
    if (!message) throw new AllayaError('That message does not exist', { code: 'NOT_FOUND' });
    return message;
  }

  private findMessage(id: string): MessageView | undefined {
    const row = this.deps.db.prepare('select * from messages where id = ?').get(id) as
      MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  // ── changing ──────────────────────────────────────────────────────────────
  create(model?: ModelRef | null): ChatView {
    const id = newId('chat');
    const at = this.now();
    const chosen = model ?? this.deps.settings.get().defaultModel;
    this.deps.db
      .prepare(
        'insert into chats (id, title, model_json, created_at, updated_at) values (?, ?, ?, ?, ?)',
      )
      .run(id, DEFAULT_TITLE, chosen ? JSON.stringify(chosen) : null, at, at);
    this.deps.events.publish('chats:changed', {});
    return toChat(this.chatRow(id));
  }

  rename(id: string, title: string): ChatView {
    this.chatRow(id);
    this.deps.db.prepare('update chats set title = ? where id = ?').run(title, id);
    this.deps.events.publish('chats:changed', {});
    return toChat(this.chatRow(id));
  }

  setModel(id: string, model: ModelRef): ChatView {
    this.chatRow(id);
    this.deps.db
      .prepare('update chats set model_json = ? where id = ?')
      .run(JSON.stringify(model), id);
    this.deps.events.publish('chats:changed', {});
    return toChat(this.chatRow(id));
  }

  remove(id: string): void {
    this.chatRow(id);
    this.running.get(id)?.abort.abort();
    this.deps.db.prepare('delete from chats where id = ?').run(id);
    this.deps.events.publish('chats:changed', {});
  }

  /** Replies that were being written when the app closed are marked stopped, keeping what was saved. */
  recoverInterrupted(): void {
    this.deps.db
      .prepare("update messages set status = 'cancelled' where status = 'streaming'")
      .run();
  }

  // ── sending ───────────────────────────────────────────────────────────────
  async send(input: {
    chatId?: string | undefined;
    text: string;
    model?: ModelRef | undefined;
  }): Promise<{ chat: ChatView; userMessage: MessageView; reply: MessageView }> {
    const existing = input.chatId ? this.chatRow(input.chatId) : undefined;
    if (existing && this.running.has(existing.id)) {
      throw new AllayaError('Allaya is still replying in this chat', {
        code: 'LIMIT_EXCEEDED',
        details: { reason: 'busy' },
      });
    }
    const ref =
      input.model ??
      (existing?.model_json ? (JSON.parse(existing.model_json) as ModelRef) : undefined) ??
      this.deps.settings.get().defaultModel ??
      (await this.deps.connections.firstModel());
    if (!ref) {
      throw new AllayaError('Connect an AI service first', {
        code: 'PROVIDER_NOT_CONFIGURED',
        details: { reason: 'no_model' },
      });
    }
    const model = await this.deps.connections.resolve(ref);

    const chatId = existing?.id ?? this.create(ref).id;
    const at = this.now();
    const userId = newId('msg');
    const replyId = newId('msg');
    const insert = this.deps.db.prepare(
      `insert into messages (id, chat_id, role, content, status, model, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deps.db.transaction(() => {
      insert.run(userId, chatId, 'user', input.text, 'complete', null, at);
      insert.run(replyId, chatId, 'assistant', '', 'streaming', model.displayName, at);
      const row = this.chatRow(chatId);
      const title =
        row.title === DEFAULT_TITLE ? oneLine(input.text, TITLE_CHARS) || DEFAULT_TITLE : row.title;
      this.deps.db
        .prepare('update chats set title = ?, model_json = ?, updated_at = ? where id = ?')
        .run(title, JSON.stringify(ref), at, chatId);
    })();
    this.deps.events.publish('chats:changed', {});

    const abort = new AbortController();
    const done = this.run(chatId, replyId, model, abort.signal).finally(() => {
      this.running.delete(chatId);
    });
    this.running.set(chatId, { abort, done });
    return {
      chat: toChat(this.chatRow(chatId)),
      userMessage: this.message(userId),
      reply: this.message(replyId),
    };
  }

  cancel(chatId: string): void {
    this.running.get(chatId)?.abort.abort();
  }

  /** Resolves when no reply is being written. For tests and for a clean shutdown. */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()].map((r) => r.done));
    }
  }

  // ── writing a reply ───────────────────────────────────────────────────────
  private history(chatId: string, upToReplyId: string): AIMessage[] {
    const rows = this.deps.db
      .prepare('select * from messages where chat_id = ? order by rowid')
      .all(chatId) as MessageRow[];
    const out: AIMessage[] = [];
    for (const row of rows) {
      if (row.id === upToReplyId) break;
      // A reply that failed or was stopped before saying anything adds nothing.
      if (!row.content.trim()) continue;
      if (row.role === 'assistant' && row.status === 'error') continue;
      const last = out.at(-1);
      // Two turns in a row from the same side (after a failed reply) are joined: providers want them to alternate.
      if (last && last.role === row.role && typeof last.content === 'string') {
        last.content = `${last.content}\n\n${row.content}`;
      } else {
        out.push({ role: row.role, content: row.content });
      }
    }
    return out;
  }

  private async run(
    chatId: string,
    replyId: string,
    model: Awaited<ReturnType<ConnectionService['resolve']>>,
    signal: AbortSignal,
  ): Promise<void> {
    const { db, events } = this.deps;
    let content = '';
    let steps: Step[] = [];
    let lastSave = 0;
    const save = (extra: { status?: MessageView['status']; error?: unknown } = {}) => {
      db.prepare(
        'update messages set content = ?, status = coalesce(?, status), error_json = ?, steps_json = ? where id = ?',
      ).run(
        content,
        extra.status ?? null,
        extra.error ? JSON.stringify(extra.error) : null,
        steps.length > 0 ? JSON.stringify(steps) : null,
        replyId,
      );
      lastSave = Date.now();
    };
    // The chat may have been deleted while the reply was being written; then there is nothing to tell the screen.
    const pushMessage = () => {
      const message = this.findMessage(replyId);
      if (message) events.publish('chat:message', message);
    };

    try {
      const tools = this.deps.tools?.list() ?? [];
      const settings = this.deps.settings.get();
      const system = buildSystemPrompt({
        userName: settings.userName,
        instructions: settings.instructions,
        now: (this.deps.now ?? (() => new Date()))(),
        hasTools: tools.length > 0,
      });
      const budget = Math.max(
        2000,
        model.contextWindow - model.maxOutputTokens - estimateTokens(system),
      );
      const { messages } = fitMessagesToBudget(this.history(chatId, replyId), budget);
      const result = await runAgent({
        provider: model.provider,
        model: model.ref.modelId,
        system,
        history: messages,
        tools,
        maxTokens: model.maxOutputTokens,
        signal,
        ...(this.deps.approve
          ? { approve: (request: ApprovalRequest) => this.deps.approve!({ ...request, chatId }) }
          : {}),
        onText: (text) => {
          content += text;
          events.publish('chat:delta', { chatId, messageId: replyId, text });
          if (Date.now() - lastSave > SAVE_EVERY_MS) save();
        },
        onStep: (step) => {
          const at = steps.findIndex((s) => s.id === step.id);
          steps = at === -1 ? [...steps, step] : steps.map((s, i) => (i === at ? step : s));
          save();
          pushMessage();
        },
      });
      content = result.text;
      steps = result.steps;
      if (result.finish === 'cancelled') save({ status: 'cancelled' });
      else if (!content.trim()) {
        const ranOut = result.finish === 'length' && steps.length > 0;
        save({
          status: 'error',
          error: ranOut
            ? {
                code: 'LIMIT_EXCEEDED',
                message: 'Allaya used too many steps without reaching an answer.',
              }
            : { code: 'PROVIDER_ERROR', message: 'The model sent back an empty reply.' },
        });
      } else save({ status: 'complete' });
    } catch (error) {
      if (signal.aborted) {
        save({ status: 'cancelled' });
      } else {
        const serialized = toSerializedError(error);
        this.logger.warn('A reply failed', { code: serialized.code });
        save({ status: 'error', error: { code: serialized.code, message: serialized.message } });
      }
    }
    pushMessage();
    events.publish('chats:changed', {});
  }
}
