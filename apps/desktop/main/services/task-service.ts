import {
  TaskOrchestrator,
  phaseOf,
  type TaskLimits,
  type TaskRecord,
  type StepRecord,
} from '@allaya/agent';
import type { ConversationRepository, TaskRepository } from '@allaya/database';
import {
  LanguageSession,
  detectLanguage,
  interpret,
  parseAnswer,
  type ResolvedResponseLanguage,
} from '@allaya/language';
import { resolveUiLocale } from '@allaya/localization';
import { AllayaError, newId, type ErrorCode, type Logger, type RunRegistry } from '@allaya/shared';
import type { AgentStatus, TaskSource } from '@allaya/types';
import type {
  TaskAssessmentView,
  TaskDetail,
  TaskEventView,
  TaskStepView,
  TaskSummary,
} from '@allaya/validation';
import type { EventPublisher } from '../ipc/events';
import { DbTaskStore } from '../tasks/db-store';
import { ProviderModel } from '../tasks/provider-model';
import { ToolServicePort } from '../tasks/tool-port';
import type { PermissionService } from './permission-service';
import type { ProviderService } from './provider-service';
import type { SettingsService } from './settings-service';
import { titleFromText } from './text';
import type { ToolService } from './tool-service';

const MAX_EVENTS_SHOWN = 400;
const STATUS_RESET_MS = 2500;

export interface TaskServiceDeps {
  repo: TaskRepository;
  conversations: ConversationRepository;
  providers: ProviderService;
  tools: ToolService;
  permissions: PermissionService;
  settings: SettingsService;
  events: EventPublisher;
  runs: RunRegistry;
  logger: Logger;
  now?: () => number;
  osLocale?: () => string;
  limits?: Partial<TaskLimits>;
  /** What Allaya remembers. Omitted in tests that do not use it. */
  memory?: { forPrompt(query: string): { text?: string | undefined } };
  /** Test seam: how long to wait before retrying a step. */
  backoffMs?: (attempt: number, code: ErrorCode | undefined) => number;
}

export interface CreateTaskInput {
  request: string;
  /** A title of its own (an automation's name); otherwise it comes from the request. */
  title?: string | undefined;
  /** The automation run that starts this task. */
  automationRunId?: string | undefined;
  planFirst?: boolean | undefined;
  source?: TaskSource | undefined;
  conversationId?: string | undefined;
  /** The reply language, when the caller already decided it (chat does). */
  language?: 'bn' | 'en' | undefined;
  /** A floor for how much planning the request gets. */
  complexity?: TaskRecord['complexity'];
}

/** Sentences Allaya writes into the conversation about a task. Bilingual, like every message it writes itself. */
const NOTICES = {
  en: {
    planReady: (title: string) =>
      `I made a plan for “${title}”. Open Tasks to review it — or say “yes” to go ahead, or “no” to cancel.`,
    declined: (summary: string) =>
      `You declined: ${summary}. Say “yes” to carry on with the rest of the task, or “no” to stop it.`,
    unanswered: (summary: string) =>
      `There was no answer in time, so I did not do: ${summary}. Say “yes” to carry on with the rest of the task, or “no” to stop it.`,
    question: (question: string) => question,
    thanks: 'Thanks — carrying on.',
    approved: 'Going ahead with the plan.',
    rejected: 'Okay, I have cancelled that task.',
    resumed: 'Carrying on with the rest.',
    stopped: 'Okay, I have stopped that task.',
    interrupted: (title: string) =>
      `“${title}” was interrupted when Allaya closed. Open Tasks to resume or cancel it.`,
  },
  bn: {
    planReady: (title: string) =>
      `“${title}”-এর জন্য একটি পরিকল্পনা করেছি। Tasks-এ গিয়ে দেখুন — অথবা “হ্যাঁ” বললে শুরু করব, “না” বললে বাতিল করব।`,
    declined: (summary: string) =>
      `আপনি এটি করতে দেননি: ${summary}। কাজের বাকি অংশ চালিয়ে যেতে “হ্যাঁ” বলুন, থামাতে “না” বলুন।`,
    unanswered: (summary: string) =>
      `সময়মতো উত্তর পাইনি, তাই এটি করিনি: ${summary}। কাজের বাকি অংশ চালিয়ে যেতে “হ্যাঁ” বলুন, থামাতে “না” বলুন।`,
    question: (question: string) => question,
    thanks: 'ধন্যবাদ — কাজ চালিয়ে যাচ্ছি।',
    approved: 'পরিকল্পনা অনুযায়ী শুরু করছি।',
    rejected: 'ঠিক আছে, কাজটি বাতিল করেছি।',
    resumed: 'বাকি অংশ চালিয়ে যাচ্ছি।',
    stopped: 'ঠিক আছে, কাজটি থামিয়ে দিয়েছি।',
    interrupted: (title: string) =>
      `“${title}” Allaya বন্ধ হওয়ার সময় থেমে গিয়েছিল। Tasks-এ গিয়ে আবার চালু বা বাতিল করুন।`,
  },
} as const;

const STATUS_OF: Partial<Record<TaskRecord['state'], AgentStatus>> = {
  CREATED: 'thinking',
  ANALYZING: 'thinking',
  PLANNING: 'thinking',
  PERMISSION_CHECK: 'thinking',
  READY: 'working',
  EXECUTING: 'working',
  ERROR: 'working',
  RECOVERY: 'working',
  RETRY: 'working',
  VERIFYING: 'verifying',
  WAITING_FOR_USER: 'paused',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'paused',
};

/** Owns tasks: creates them, runs them through the orchestrator, keeps the UI and the conversation informed. */
export class TaskService {
  readonly orchestrator: TaskOrchestrator;
  private readonly store: DbTaskStore;
  private readonly changedIds = new Set<string>();
  private flushScheduled = false;
  private readonly lastStatus = new Map<string, string>();
  /** The memory block each task was given, worked out once per task (so a use is counted once, not per model call). */
  private readonly memoryOf = new Map<string, string | undefined>();
  private readonly listeners = new Set<(task: TaskRecord) => void>();

  constructor(private readonly deps: TaskServiceDeps) {
    this.store = new DbTaskStore(deps.repo);
    this.orchestrator = new TaskOrchestrator({
      store: this.store,
      model: new ProviderModel(deps.providers),
      tools: new ToolServicePort(
        deps.tools,
        deps.permissions,
        (taskId) => this.store.get(taskId)?.conversationId,
      ),
      runs: {
        begin: (taskId) => deps.runs.start(runKey(taskId), 'task').signal,
        end: (taskId) => deps.runs.finish(runKey(taskId)),
      },
      logger: deps.logger,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.limits ? { limits: deps.limits } : {}),
      ...(deps.backoffMs ? { backoffMs: deps.backoffMs } : {}),
      userName: () => deps.settings.get('profile.displayName') || undefined,
      memory: (task) => this.memoryFor(task),
      onChange: (taskId) => this.scheduleChanged(taskId),
      onEvent: (event) => this.onTaskEvent(event.taskId, event.type),
      onFinished: (task) => this.finished(task),
    });
    // The emergency stop and a typed "stop" also drop tasks that are queued behind the running one.
    deps.runs.events.on('stopped', ({ reason }) => this.orchestrator.cancelAll(reason));
  }

  // ── queries ───────────────────────────────────────────────────────────────
  list(limit = 100): TaskSummary[] {
    return this.deps.repo.list({ limit }).map((row) => {
      const task = this.store.get(row.id)!;
      return this.summary(task, this.store.steps(task.id));
    });
  }

  get(id: string): TaskDetail {
    const task = this.require(id);
    const steps = this.store.steps(id);
    const events = this.store.events(id);
    const assessment = this.orchestrator.assess(task);
    return {
      task: this.summary(task, steps),
      request: task.request,
      ...(task.plan
        ? {
            plan: {
              summary: task.plan.summary,
              ...(task.plan.successCriteria ? { successCriteria: task.plan.successCriteria } : {}),
            },
          }
        : {}),
      steps: steps.map(toStepView),
      events: events.slice(-MAX_EVENTS_SHOWN).map((event): TaskEventView => ({
        id: event.id,
        seq: event.seq,
        type: event.type,
        ...(event.payload ? { payload: event.payload } : {}),
        createdAt: event.createdAt,
      })),
      ...(assessment ? { assessment: toAssessmentView(assessment) } : {}),
      usage: task.usage,
    };
  }

  // ── commands ──────────────────────────────────────────────────────────────
  create(input: CreateTaskInput): TaskSummary {
    const language = input.language ?? this.languageFor(input.request);
    const task = this.orchestrator.create({
      title: input.title ? titleFromText(input.title, 80) : titleFromText(input.request, 80),
      ...(input.automationRunId ? { automationRunId: input.automationRunId } : {}),
      request: input.request,
      language,
      source: input.source ?? 'chat',
      planFirst: input.planFirst ?? false,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.complexity ? { complexity: input.complexity } : {}),
    });
    this.orchestrator.start(task.id);
    return this.summary(this.require(task.id), []);
  }

  approve(id: string): void {
    this.require(id);
    this.orchestrator.approvePlan(id);
  }

  reject(id: string): void {
    this.require(id);
    this.orchestrator.rejectPlan(id);
  }

  answer(id: string, text: string): void {
    this.require(id);
    this.orchestrator.answer(id, text);
  }

  pause(id: string): boolean {
    this.require(id);
    return this.orchestrator.pause(id);
  }

  resume(id: string): void {
    this.require(id);
    this.orchestrator.resume(id);
  }

  cancel(id: string): boolean {
    this.require(id);
    return this.orchestrator.cancel(id);
  }

  /** Removes a finished task and its history. Anything not finished must be stopped first. */
  remove(id: string): boolean {
    const task = this.require(id);
    if (!isFinal(task)) {
      throw new AllayaError('Stop the task before removing it', { code: 'CONFLICT' });
    }
    const removed = this.deps.repo.remove(id);
    if (removed) this.deps.events.publish('tasks:removed', { ids: [id] });
    return removed;
  }

  clearFinished(): number {
    const ids = this.deps.repo
      .list({ states: ['COMPLETED', 'FAILED', 'CANCELLED'], limit: 500 })
      .map((row) => row.id);
    for (const id of ids) this.deps.repo.remove(id);
    if (ids.length > 0) this.deps.events.publish('tasks:removed', { ids });
    return ids.length;
  }

  /** Startup: tasks the last session left mid-flight are paused as interrupted, never resumed by themselves. */
  recover(): number {
    const count = this.orchestrator.recover();
    return count;
  }

  /** Quitting: running tasks are paused as interrupted (so they can be resumed), not cancelled. */
  shutdown(): void {
    this.orchestrator.shutdown();
  }

  /** Called (after each burst of changes) with every task that changed. Returns how to stop listening. */
  subscribe(listener: (task: TaskRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Where a task stands, or `undefined` if it no longer exists. */
  snapshot(id: string): TaskRecord | undefined {
    return this.store.get(id);
  }

  // ── conversation hooks ────────────────────────────────────────────────────
  /**
   * A message typed in a conversation where a task is waiting: an answer to its question, or a yes/no to its plan
   * or to a declined action. Returns Allaya's reply, or `undefined` when the message is not for the task (then it
   * is ordinary chat).
   */
  answerFromChat(conversationId: string, text: string): string | undefined {
    const waiting = this.store
      .listByState(['WAITING_FOR_USER'])
      .filter(
        (task) => task.conversationId === conversationId && !this.orchestrator.isRunning(task.id),
      )
      .at(-1);
    if (!waiting?.pending) return undefined;
    const notices = NOTICES[waiting.language];
    const { pending } = waiting;
    if (pending.kind === 'question') {
      // A clear command of its own ("open my Downloads folder") is a new request, not an answer.
      if (this.isCommand(text)) return undefined;
      this.orchestrator.answer(waiting.id, text);
      return notices.thanks;
    }
    const verdict = parseAnswer(text);
    if (verdict === 'unclear') return undefined;
    if (pending.kind === 'plan_approval') {
      if (verdict === 'yes') {
        this.orchestrator.approvePlan(waiting.id);
        return notices.approved;
      }
      this.orchestrator.rejectPlan(waiting.id);
      return notices.rejected;
    }
    if (verdict === 'yes') {
      this.orchestrator.resume(waiting.id);
      return notices.resumed;
    }
    this.orchestrator.cancel(waiting.id);
    return notices.stopped;
  }

  /** Whether the words are a complete command Allaya understands on its own, rather than an answer. */
  private isCommand(text: string): boolean {
    try {
      const now = new Date(this.deps.now?.() ?? Date.now());
      const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
      const result = interpret(text, {}, { today });
      return (
        !result.needsPlanner &&
        result.clauses.length > 0 &&
        result.clauses.every((clause) => clause.type !== 'UNKNOWN')
      );
    } catch {
      return false;
    }
  }

  /** "Cancel" typed in a conversation also stops the task that conversation started. */
  cancelForConversation(conversationId: string): boolean {
    let cancelled = false;
    for (const task of this.store.listByState([
      'CREATED',
      'ANALYZING',
      'PLANNING',
      'PERMISSION_CHECK',
      'READY',
      'EXECUTING',
      'VERIFYING',
      'ERROR',
      'RECOVERY',
      'RETRY',
      'WAITING_FOR_USER',
      'PAUSED',
    ])) {
      if (task.conversationId === conversationId && this.orchestrator.cancel(task.id)) {
        cancelled = true;
      }
    }
    return cancelled;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────
  private languageFor(request: string): 'bn' | 'en' {
    const resolved: ResolvedResponseLanguage = new LanguageSession().resolve(
      this.deps.settings.get('language.response'),
      detectLanguage(request),
      resolveUiLocale(this.deps.settings.get('language.ui'), this.deps.osLocale?.()) === 'bn'
        ? 'bn'
        : 'en',
    );
    return resolved.language === 'en' ? 'en' : 'bn';
  }

  private summary(task: TaskRecord, steps: readonly StepRecord[]): TaskSummary {
    return {
      id: task.id,
      ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      title: task.title,
      state: task.state,
      phase: phaseOf(task.state),
      source: task.source,
      ...(task.complexity ? { complexity: task.complexity } : {}),
      language: task.language,
      planFirst: task.planFirst,
      riskLevel: task.riskLevel,
      ...(task.resultSummary ? { resultSummary: task.resultSummary } : {}),
      ...(task.outcome ? { outcome: task.outcome } : {}),
      ...(task.error ? { error: { code: task.error.code, message: task.error.message } } : {}),
      filesChanged: task.filesChanged,
      actionCount: task.actionCount,
      stepCount: steps.length,
      stepsDone: steps.filter((step) => step.state === 'done').length,
      ...(task.pending ? { pending: task.pending } : {}),
      ...(task.state === 'PAUSED' && task.pauseReason ? { pauseReason: task.pauseReason } : {}),
      running: this.orchestrator.isRunning(task.id),
      queued: this.orchestrator.isQueued(task.id),
      ...(task.modelLabel ? { modelLabel: task.modelLabel } : {}),
      createdAt: task.createdAt,
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      updatedAt: task.updatedAt,
    };
  }

  /** Several changes in one tick become one push. */
  private scheduleChanged(taskId: string): void {
    this.changedIds.add(taskId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const ids = [...this.changedIds];
      this.changedIds.clear();
      for (const id of ids) this.publishChanged(id);
    });
  }

  private publishChanged(taskId: string): void {
    try {
      const task = this.store.get(taskId);
      if (!task) return;
      this.deps.events.publish('tasks:changed', this.summary(task, this.store.steps(taskId)));
      this.publishStatus(task);
      for (const listener of this.listeners) {
        try {
          listener(task);
        } catch (error) {
          this.deps.logger.warn('A task listener failed', { error: String(error) });
        }
      }
    } catch (error) {
      // Quitting: the database may already be closed.
      this.deps.logger.warn('Could not publish a task change', { error: String(error) });
    }
  }

  private publishStatus(task: TaskRecord): void {
    const status = STATUS_OF[task.state] ?? 'working';
    const key = `${status}:${task.title}`;
    if (this.lastStatus.get(task.id) === key) return;
    this.lastStatus.set(task.id, key);
    this.deps.events.publish('agent:status', {
      status,
      detail: task.title.slice(0, 200),
      activeRuns: this.deps.runs.active().length,
    });
    if (status === 'completed' || status === 'failed' || status === 'paused') {
      setTimeout(() => {
        if (this.deps.runs.active().length === 0) {
          this.deps.events.publish('agent:status', { status: 'ready', activeRuns: 0 });
        }
      }, STATUS_RESET_MS).unref?.();
    }
  }

  /**
   * A task that needs the person says so in the conversation it came from. Each of these events happens exactly
   * once per request, so nothing is announced twice. (They fire just before the state changes, hence the tick.)
   */
  private onTaskEvent(taskId: string, type: string): void {
    if (
      type !== 'CLARIFICATION_REQUESTED' &&
      type !== 'PLAN_APPROVAL_REQUESTED' &&
      type !== 'USER_DECLINED' &&
      type !== 'INTERRUPTED'
    ) {
      return;
    }
    queueMicrotask(() => {
      try {
        const task = this.store.get(taskId);
        if (!task?.conversationId) return;
        const notices = NOTICES[task.language];
        if (type === 'INTERRUPTED') {
          this.post(task, notices.interrupted(task.title));
        } else if (task.state === 'WAITING_FOR_USER' && task.pending) {
          this.post(
            task,
            task.pending.kind === 'question'
              ? notices.question(task.pending.question)
              : task.pending.kind === 'plan_approval'
                ? notices.planReady(task.title)
                : task.pending.unanswered
                  ? notices.unanswered(task.pending.summary)
                  : notices.declined(task.pending.summary),
          );
        }
      } catch (error) {
        this.deps.logger.warn('Could not announce a task', { error: String(error) });
      }
    });
  }

  private memoryFor(task: TaskRecord): string | undefined {
    if (!this.deps.memory) return undefined;
    if (!this.memoryOf.has(task.id)) {
      this.memoryOf.set(task.id, this.deps.memory.forPrompt(task.request).text);
    }
    return this.memoryOf.get(task.id);
  }

  private finished(task: TaskRecord): void {
    this.lastStatus.delete(task.id);
    this.memoryOf.delete(task.id);
    if (task.state === 'CANCELLED') return; // the person did that; no need to announce it
    const text =
      task.state === 'COMPLETED' ? task.resultSummary : (task.resultSummary ?? task.error?.message);
    if (text) this.post(task, text);
  }

  /** Writes an assistant message into the task's conversation, linked to the task, and tells the chat screen. */
  private post(task: TaskRecord, content: string): void {
    const { conversations, events } = this.deps;
    if (!task.conversationId || !conversations.get(task.conversationId)) return;
    try {
      const row = conversations.addMessage({
        id: newId('msg'),
        conversationId: task.conversationId,
        kind: 'assistant',
        content,
        taskId: task.id,
        metadata: { status: 'complete', local: 'task' },
      });
      events.publish('chat:finished', {
        conversationId: task.conversationId,
        message: {
          id: row.id,
          conversationId: row.conversationId,
          kind: 'assistant',
          content: row.content,
          createdAt: row.createdAt,
          status: 'complete',
          taskId: task.id,
        },
      });
      events.publish('chat:conversationsChanged', {});
    } catch (error) {
      this.deps.logger.warn('Could not post a task message', { error: String(error) });
    }
  }

  private require(id: string): TaskRecord {
    const task = this.store.get(id);
    if (!task) throw new AllayaError('Task not found', { code: 'NOT_FOUND' });
    return task;
  }
}

const runKey = (taskId: string) => `task:${taskId}`;

const isFinal = (task: TaskRecord) =>
  task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELLED';

function toStepView(step: StepRecord): TaskStepView {
  return {
    id: step.id,
    position: step.position,
    planStepId: step.planStepId,
    title: step.title,
    ...(step.detail ? { detail: step.detail } : {}),
    ...(step.expected ? { expected: step.expected } : {}),
    ...(step.toolHint ? { toolHint: step.toolHint } : {}),
    optional: step.optional,
    dependsOn: step.dependsOn,
    state: step.state,
    attempts: step.attempts,
    ...(step.summary ? { summary: step.summary } : {}),
    ...(step.evidence ? { evidence: step.evidence } : {}),
    unverified: step.unverified,
    ...(step.error ? { error: step.error } : {}),
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.completedAt ? { completedAt: step.completedAt } : {}),
  };
}

function toAssessmentView(
  assessment: NonNullable<ReturnType<TaskOrchestrator['assess']>>,
): TaskAssessmentView {
  return {
    risk: assessment.risk,
    tools: assessment.tools,
    subjects: assessment.subjects,
    readOnly: assessment.readOnly,
    needsApproval: assessment.needsApproval,
    reasons: assessment.reasons,
  };
}
