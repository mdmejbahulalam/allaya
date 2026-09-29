import type { AIMessage, ToolResultPart } from '@allaya/ai';
import {
  AllayaError,
  newId,
  toSerializedError,
  type ErrorCode,
  type Logger,
  type SerializedError,
} from '@allaya/shared';
import { formatResultForModel, type ExecutionProgress, type ExecutionResult } from '@allaya/tools';
import { RISK_LEVELS, type RiskLevel, type TaskEventType, type TaskState } from '@allaya/types';
import { classifyComplexity, needsPlanning } from './complexity';
import { assertTransition, canPause, isTerminal, resumeTarget } from './machine';
import { INTERRUPTED_NOTE, NUDGE_TO_FINISH, messagesFor, retryNoteFor } from './messages';
import {
  assessPlan,
  parsePlanSubmission,
  singleStepPlan,
  validatePlan,
  type Plan,
  type PlanAssessment,
} from './plan';
import {
  CONTROL_TOOLS,
  askUserSchema,
  askUserSpec,
  clip,
  finishStepSchema,
  finishStepSpec,
  finishTaskSchema,
  finishTaskSpec,
  plannerSystemPrompt,
  plannerUserMessage,
  stepBrief,
  stepSystemPrompt,
  submitPlanSpec,
  summarySystemPrompt,
  summaryUserMessage,
  type PromptContext,
} from './prompts';
import {
  DEFAULT_TASK_LIMITS,
  type AgentModel,
  type ModelInput,
  type ModelTurn,
  type NewTask,
  type PendingRequest,
  type StepRecord,
  type TaskEventRecord,
  type TaskLimits,
  type TaskRecord,
  type TaskStore,
  type ToolPort,
} from './types';

/** A refusal that will not change on a second try: a retry could only tempt the model into a workaround. */
const FINAL_REFUSALS: ReadonlySet<ErrorCode> = new Set([
  'PERMISSION_DENIED',
  'PERMISSION_REQUIRED',
  'PATH_NOT_ALLOWED',
  'UNSAFE_PATH',
  'UNSUPPORTED_PLATFORM',
  'CONFIRMATION_REJECTED',
]);

const RETRY_BACKOFF_CODES: ReadonlySet<ErrorCode> = new Set([
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
]);

const MAX_EVIDENCE_LINES = 12;
const MAX_CLARIFICATION = 2000;

export interface OrchestratorDeps {
  store: TaskStore;
  model: AgentModel;
  tools: ToolPort;
  limits?: Partial<TaskLimits>;
  logger?: Logger;
  now?: () => number;
  /** For each run, a signal the app can abort (the emergency stop, "stop"). */
  runs?: { begin(taskId: string): AbortSignal; end(taskId: string): void };
  /** Called after any change to a task, its steps or its timeline. */
  onChange?: (taskId: string) => void;
  onEvent?: (event: TaskEventRecord) => void;
  /** Called once when a task reaches a final state. */
  onFinished?: (task: TaskRecord) => void;
  userName?: () => string | undefined;
  /** The remembered facts that bear on this task, as a fenced block for the prompts (or none). */
  memory?: (task: TaskRecord) => string | undefined;
  /** How long to wait before retrying (default: back off for busy or unreachable models only). */
  backoffMs?: (attempt: number, code: ErrorCode | undefined) => number;
  /** Tasks that run at once. Default 1: two tasks must never fight over the mouse and keyboard. */
  maxConcurrent?: number;
}

/** Thrown at a safe point when the user asked to pause. */
class PauseRequested extends Error {
  constructor() {
    super('pause requested');
    this.name = 'PauseRequested';
  }
}

const cancelledError = (reason = 'Cancelled') => new AllayaError(reason, { code: 'CANCELLED' });

interface Run {
  taskId: string;
  hard: AbortController;
  pause: AbortController;
  /** Aborted by cancel, by the app's run registry (emergency stop) — never by pause. */
  signal: AbortSignal;
  startedAt: number;
  baseElapsedMs: number;
  /** The app is closing: the task is paused as interrupted, not cancelled. */
  interrupted: boolean;
  done: Promise<void>;
}

interface CallLog {
  tool: string;
  readOnly: boolean;
  files: boolean;
  ok: boolean;
  status: ExecutionResult['status'];
  verification: ExecutionResult['verification'];
  summary: string;
  evidence?: string | undefined;
  errorMessage?: string | undefined;
  errorCode?: ErrorCode | undefined;
}

type StepOutcome =
  | { kind: 'done'; summary: string; evidence: string; unverified: boolean }
  | {
      kind: 'failed';
      message: string;
      retryable: boolean;
      code?: ErrorCode | undefined;
      /** What the model is told on the next attempt, when it differs from `message`. */
      note?: string | undefined;
    }
  | { kind: 'question'; question: string }
  | { kind: 'declined'; tool: string; summary: string; unanswered: boolean };

const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  RISK_LEVELS.indexOf(b) > RISK_LEVELS.indexOf(a) ? b : a;

const defaultBackoff = (attempt: number, code: ErrorCode | undefined): number =>
  code && RETRY_BACKOFF_CODES.has(code) ? Math.min(2000 * 2 ** (attempt - 1), 15_000) : 0;

/**
 * Runs a task from request to result, and keeps it honest.
 *
 *   understand → plan (only if worth it) → check what the plan touches → ask if needed → do it step by step
 *   → verify → answer
 *
 * The model proposes (a plan, the next tool call, "this step is done"); the orchestrator disposes: a step counts
 * as done only if the tool results support it, a declined action stays declined, every budget is enforced here,
 * and every change of state goes through the state machine and is written down before anything else happens.
 * Actions themselves always run through the tool pipeline, so a task can never do what a chat message could not.
 */
export class TaskOrchestrator {
  private readonly limits: TaskLimits;
  private readonly now: () => number;
  private readonly runs = new Map<string, Run>();
  private readonly queue: string[] = [];
  private readonly maxConcurrent: number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.limits = { ...DEFAULT_TASK_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.maxConcurrent = deps.maxConcurrent ?? 1;
  }

  private get store(): TaskStore {
    return this.deps.store;
  }

  // ── public API ────────────────────────────────────────────────────────────
  /** Records a new task (state CREATED). Call `start` to run it. */
  create(input: Omit<NewTask, 'id'> & { id?: string }): TaskRecord {
    const title = clip(input.title.trim() || input.request, 80);
    const record = this.store.create({ ...input, id: input.id ?? newId('task'), title });
    this.event(record.id, 'TASK_CREATED', { source: record.source });
    this.changed(record.id);
    return record;
  }

  /** Queues a CREATED task; it runs as soon as a slot is free. */
  start(taskId: string): void {
    const task = this.require(taskId);
    if (task.state !== 'CREATED') {
      throw new AllayaError('This task has already been started', { code: 'CONFLICT' });
    }
    this.schedule(taskId);
  }

  /** The person said yes to the plan. */
  approvePlan(taskId: string): void {
    const task = this.require(taskId);
    if (task.state !== 'WAITING_FOR_USER' || task.pending?.kind !== 'plan_approval') {
      throw new AllayaError('This task is not waiting for approval', { code: 'CONFLICT' });
    }
    this.event(taskId, 'PLAN_APPROVED');
    this.transition(taskId, 'READY', { pending: undefined, resumeState: undefined });
    this.schedule(taskId);
  }

  /** The person said no to the plan: nothing has been done, so the task ends as cancelled. */
  rejectPlan(taskId: string): void {
    const task = this.require(taskId);
    if (task.state !== 'WAITING_FOR_USER' || task.pending?.kind !== 'plan_approval') {
      throw new AllayaError('This task is not waiting for approval', { code: 'CONFLICT' });
    }
    this.event(taskId, 'PLAN_REJECTED');
    this.cancelTask(taskId, 'The plan was not approved');
  }

  /** Answers a question the task asked. The answer becomes part of the request. */
  answer(taskId: string, text: string): void {
    const task = this.require(taskId);
    if (task.state !== 'WAITING_FOR_USER' || task.pending?.kind !== 'question') {
      throw new AllayaError('This task is not waiting for an answer', { code: 'CONFLICT' });
    }
    const answer = clip(text, MAX_CLARIFICATION);
    if (!answer) throw new AllayaError('The answer is empty', { code: 'INVALID_INPUT' });
    const request = `${task.request}\n\nQuestion from Allaya: ${task.pending.question}\nAnswer from the user: ${answer}`;
    this.event(taskId, 'TASK_RESUMED', { answered: true });
    this.transition(taskId, task.resumeState ?? 'EXECUTING', {
      request,
      pending: undefined,
      resumeState: undefined,
    });
    this.schedule(taskId);
  }

  /** Pauses at the next safe point (after the current action), or right away if nothing is running. */
  pause(taskId: string): boolean {
    const task = this.require(taskId);
    if (isTerminal(task.state) || task.state === 'PAUSED') return false;
    const run = this.runs.get(taskId);
    if (run) {
      run.pause.abort();
      return true;
    }
    if (!canPause(task.state)) return false;
    this.dequeue(taskId);
    this.applyPause(taskId, 'user');
    return true;
  }

  /** Continues a paused task, or a task waiting after the person declined an action. */
  resume(taskId: string): void {
    const task = this.require(taskId);
    if (task.state === 'WAITING_FOR_USER' && task.pending?.kind === 'declined') {
      this.event(taskId, 'TASK_RESUMED', { afterDecline: true });
      this.transition(taskId, 'EXECUTING', { pending: undefined, resumeState: undefined });
      this.schedule(taskId);
      return;
    }
    if (task.state !== 'PAUSED') {
      throw new AllayaError('This task is not paused', { code: 'CONFLICT' });
    }
    const target = resumeTarget(task.pausedFrom);
    this.event(taskId, 'TASK_RESUMED');
    this.transition(taskId, target, { pausedFrom: undefined, pauseReason: undefined });
    // Back to waiting for an answer: nothing to run until the person responds.
    if (target !== 'WAITING_FOR_USER') this.schedule(taskId);
  }

  /** Stops a task for good. A running action is asked to stop; nothing further happens. */
  cancel(taskId: string, reason = 'Cancelled by the user'): boolean {
    const task = this.require(taskId);
    if (isTerminal(task.state)) return false;
    const run = this.runs.get(taskId);
    if (run) {
      run.hard.abort(cancelledError(reason));
      return true;
    }
    this.dequeue(taskId);
    this.cancelTask(taskId, reason);
    return true;
  }

  /** Emergency stop: everything running is cancelled, and everything waiting to run is dropped. */
  cancelAll(reason = 'Stopped'): number {
    let count = 0;
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
    ])) {
      if (this.cancel(task.id, reason)) count += 1;
    }
    return count;
  }

  isRunning(taskId: string): boolean {
    return this.runs.has(taskId);
  }

  /** Not running yet because another task is. */
  isQueued(taskId: string): boolean {
    return this.queue.includes(taskId);
  }

  /** Resolves when nothing is running and nothing is queued (tests, orderly shutdown). */
  async idle(): Promise<void> {
    while (this.runs.size > 0 || this.queue.length > 0) {
      await Promise.all([...this.runs.values()].map((run) => run.done));
      await Promise.resolve();
    }
  }

  /**
   * Startup: nothing is running, so any task the last session left mid-flight is set to PAUSED (interrupted).
   * It never resumes by itself — an action started hours ago is not repeated without the person deciding.
   */
  recover(): number {
    const stale = this.store.listByState([
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
    ]);
    for (const task of stale) {
      this.event(task.id, 'INTERRUPTED', { from: task.state });
      this.applyPause(task.id, 'interrupted');
    }
    return stale.length;
  }

  /**
   * The app is closing. Whatever is running is paused as interrupted (never cancelled, so it can be resumed next
   * time), its actions are asked to stop, and nothing more is started.
   */
  shutdown(): void {
    this.queue.length = 0;
    for (const run of this.runs.values()) {
      run.interrupted = true;
      try {
        this.applyPause(run.taskId, 'interrupted');
      } catch (error) {
        this.deps.logger?.warn('Could not pause a task for shutdown', { error: String(error) });
      }
      run.hard.abort(cancelledError('The app was closed'));
    }
  }

  // ── scheduling ────────────────────────────────────────────────────────────
  private schedule(taskId: string): void {
    // The task's previous run may still be winding down (it has paused, but has not finished cleaning up):
    // start the next one only after it, never alongside it.
    const winding = this.runs.get(taskId);
    if (winding) {
      void winding.done.then(() => this.schedule(taskId));
      return;
    }
    if (!this.queue.includes(taskId)) this.queue.push(taskId);
    this.changed(taskId);
    this.pump();
  }

  private dequeue(taskId: string): void {
    const index = this.queue.indexOf(taskId);
    if (index !== -1) this.queue.splice(index, 1);
  }

  private pump(): void {
    while (this.runs.size < this.maxConcurrent && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      const task = this.store.get(taskId);
      if (!task || isTerminal(task.state) || task.state === 'PAUSED') continue;
      if (task.state === 'WAITING_FOR_USER') continue;
      this.launch(task);
    }
  }

  private launch(task: TaskRecord): void {
    const hard = new AbortController();
    const external = this.deps.runs?.begin(task.id);
    const run: Run = {
      taskId: task.id,
      hard,
      pause: new AbortController(),
      signal: external ? AbortSignal.any([hard.signal, external]) : hard.signal,
      startedAt: this.now(),
      baseElapsedMs: task.usage.elapsedMs,
      interrupted: false,
      done: Promise.resolve(),
    };
    this.runs.set(task.id, run);
    this.changed(task.id);
    run.done = this.drive(task.id, run).finally(() => {
      this.runs.delete(task.id);
      this.deps.runs?.end(task.id);
      try {
        const latest = this.store.get(task.id);
        if (latest) {
          this.persistElapsed(latest.id, run);
          this.changed(latest.id);
          if (isTerminal(latest.state)) this.deps.onFinished?.(latest);
        }
      } catch (error) {
        // The store can already be closed when the app is quitting; there is nothing left to record.
        this.deps.logger?.warn('Could not record the end of a task run', { error: String(error) });
      }
      this.pump();
    });
  }

  // ── the run ───────────────────────────────────────────────────────────────
  private async drive(taskId: string, run: Run): Promise<void> {
    try {
      for (;;) {
        this.checkpoint(taskId, run);
        const task = this.require(taskId);
        switch (task.state) {
          case 'CREATED':
            this.transition(taskId, 'ANALYZING', { startedAt: task.startedAt ?? this.now() });
            this.event(taskId, 'TASK_STARTED');
            break;
          case 'ANALYZING':
            this.analyze(taskId);
            break;
          case 'PLANNING':
            if (!(await this.plan(taskId, run))) return;
            break;
          case 'PERMISSION_CHECK':
            if (!this.checkPlan(taskId)) return;
            break;
          case 'READY':
            this.transition(taskId, 'EXECUTING');
            break;
          case 'EXECUTING':
          case 'RETRY':
            if ((await this.runSteps(taskId, run)) === 'stop') return;
            break;
          case 'VERIFYING':
            await this.finish(taskId, run);
            return;
          default:
            // Terminal, paused, waiting — or a transient state a crash left behind; `recover` handles those.
            return;
        }
      }
    } catch (error) {
      try {
        this.handleRunError(taskId, run, error);
      } catch (inner) {
        this.deps.logger?.warn('Could not record how a task run ended', { error: String(inner) });
      }
    }
  }

  private handleRunError(taskId: string, run: Run, error: unknown): void {
    const task = this.store.get(taskId);
    if (!task || isTerminal(task.state)) return;
    // Quitting already paused it (as interrupted); stopping its actions must not turn that into a cancellation.
    if (run.interrupted && task.state === 'PAUSED') return;
    if (error instanceof PauseRequested) {
      this.applyPause(taskId, 'user');
      return;
    }
    const serialized = toSerializedError(error);
    if (run.signal.aborted || serialized.code === 'CANCELLED') {
      const reason = run.signal.reason;
      this.cancelTask(taskId, reason instanceof Error ? reason.message : undefined);
      return;
    }
    if (serialized.code === 'LIMIT_EXCEEDED') {
      this.event(taskId, 'BUDGET_EXCEEDED', { message: serialized.message });
    } else {
      this.deps.logger?.error('Task failed unexpectedly', { taskId, code: serialized.code });
    }
    this.failTask(taskId, serialized);
  }

  /** Cancel, pause and the budgets are all checked here, before every model call and every step. */
  private checkpoint(taskId: string, run: Run): void {
    if (run.signal.aborted) throw cancelledError();
    if (run.pause.signal.aborted) throw new PauseRequested();
    const task = this.require(taskId);
    const elapsed = this.elapsed(run);
    if (elapsed > this.limits.maxWallClockMs) {
      throw new AllayaError(
        messagesFor(task.language).limitTime(Math.round(this.limits.maxWallClockMs / 60_000)),
        { code: 'LIMIT_EXCEEDED' },
      );
    }
  }

  private elapsed(run: Run): number {
    return run.baseElapsedMs + (this.now() - run.startedAt);
  }

  private persistElapsed(taskId: string, run: Run): void {
    const task = this.store.get(taskId);
    if (!task) return;
    this.store.update(taskId, { usage: { ...task.usage, elapsedMs: this.elapsed(run) } });
  }

  // ── understanding ─────────────────────────────────────────────────────────
  private analyze(taskId: string): void {
    const task = this.require(taskId);
    const classified = classifyComplexity(task.request, new Date(this.now()));
    // The complexity given at creation is a floor: a request already judged multi-step is never one step.
    const order = ['trivial', 'simple', 'multi_step', 'complex'] as const;
    const complexity =
      task.complexity && order.indexOf(task.complexity) > order.indexOf(classified.complexity)
        ? task.complexity
        : classified.complexity;
    this.store.update(taskId, { complexity });
    if (needsPlanning(complexity) || task.planFirst) {
      this.transition(taskId, 'PLANNING');
      return;
    }
    this.setPlan(taskId, singleStepPlan(task.title));
    this.transition(taskId, 'EXECUTING');
  }

  // ── planning ──────────────────────────────────────────────────────────────
  /** Returns true when a valid plan is stored (state PERMISSION_CHECK); false when the task is waiting or done. */
  private async plan(taskId: string, run: Run): Promise<boolean> {
    const task = this.require(taskId);
    const specs = this.deps.tools.specs();
    const knownTools = new Set(specs.map((spec) => spec.name));
    const canAsk = task.usage.questions < this.limits.maxQuestions;
    let issues: string[] | undefined;

    for (let attempt = 0; attempt <= this.limits.maxPlanRepairs; attempt += 1) {
      const current = this.require(taskId);
      const turn = await this.callModel(taskId, run, {
        purpose: 'plan',
        system:
          plannerSystemPrompt(this.promptContext(current), this.limits.maxSteps) +
          (canAsk
            ? ''
            : '\nYou may NOT ask the user anything more: make sensible assumptions and state them in the summary.'),
        messages: [
          {
            role: 'user',
            content: plannerUserMessage(current.request, specs, issues ? { issues } : undefined),
          },
        ],
        tools: [submitPlanSpec()],
        forceTool: CONTROL_TOOLS.submitPlan,
        maxTokens: 3000,
      });
      const call = turn.calls.find((c) => c.name === CONTROL_TOOLS.submitPlan);
      if (!call) {
        issues = [`You did not call ${CONTROL_TOOLS.submitPlan}.`];
        continue;
      }
      const submission = parsePlanSubmission(call.arguments);
      if (submission.kind === 'question') {
        if (!canAsk) {
          this.failTask(
            taskId,
            {
              code: 'GOAL_NOT_MET',
              message: messagesFor(current.language).needsInformation(submission.question),
              retryable: false,
            },
            messagesFor(current.language).needsInformation(submission.question),
          );
          return false;
        }
        this.ask(taskId, submission.question, 'PLANNING');
        return false;
      }
      if (submission.kind === 'invalid') {
        issues = [submission.reason];
        continue;
      }
      const problems = validatePlan(submission.plan, {
        maxSteps: this.limits.maxSteps,
        knownTools,
      });
      if (problems.length > 0) {
        issues = problems;
        continue;
      }
      this.setPlan(taskId, submission.plan);
      this.transition(taskId, 'PERMISSION_CHECK');
      return true;
    }
    const message = messagesFor(task.language).planFailed;
    this.failTask(
      taskId,
      {
        code: 'PLAN_INVALID',
        message,
        retryable: true,
        ...(issues ? { details: { issues } } : {}),
      },
      message,
    );
    return false;
  }

  private setPlan(taskId: string, plan: Plan): void {
    const steps: StepRecord[] = plan.steps.map((step, position) => ({
      id: newId('step'),
      taskId,
      position,
      planStepId: step.id,
      title: step.title,
      detail: step.detail,
      expected: step.expected,
      toolHint: step.toolHint,
      optional: step.optional,
      dependsOn: step.dependsOn,
      state: 'pending',
      attempts: 0,
      unverified: false,
    }));
    this.store.replaceSteps(taskId, steps);
    this.store.update(taskId, { plan });
    this.event(taskId, 'PLAN_CREATED', { steps: plan.steps.length });
    this.changed(taskId);
  }

  /** What a plan is likely to touch. Also used by the app to show the plan before approval. */
  assess(task: TaskRecord): PlanAssessment | undefined {
    if (!task.plan) return undefined;
    return assessPlan(task.plan, (name) => this.deps.tools.facts(name), {
      planFirst: task.planFirst,
      approvalStepThreshold: this.limits.approvalStepThreshold,
    });
  }

  /** Returns true when the plan may run now; false when it waits for the person's approval. */
  private checkPlan(taskId: string): boolean {
    const task = this.require(taskId);
    const assessment = this.assess(task);
    if (assessment?.needsApproval) {
      this.event(taskId, 'PLAN_APPROVAL_REQUESTED', {
        risk: assessment.risk,
        reasons: assessment.reasons,
      });
      this.transition(taskId, 'WAITING_FOR_USER', {
        pending: { kind: 'plan_approval' },
        resumeState: 'READY',
      });
      return false;
    }
    this.transition(taskId, 'READY');
    return true;
  }

  private ask(taskId: string, question: string, resumeState: TaskState): void {
    const task = this.require(taskId);
    this.event(taskId, 'CLARIFICATION_REQUESTED', { question });
    this.transition(taskId, 'WAITING_FOR_USER', {
      pending: { kind: 'question', question },
      resumeState,
      usage: { ...task.usage, questions: task.usage.questions + 1 },
    });
  }

  // ── doing the steps ───────────────────────────────────────────────────────
  /** `verify` when every step has been dealt with; `stop` when the task is waiting, paused, or over. */
  private async runSteps(taskId: string, run: Run): Promise<'verify' | 'stop'> {
    if (this.require(taskId).state === 'RETRY') this.transition(taskId, 'EXECUTING');

    for (;;) {
      this.checkpoint(taskId, run);
      const task = this.require(taskId);
      const plan = task.plan;
      if (!plan) {
        this.failTask(taskId, {
          code: 'INTERNAL',
          message: 'The task has no plan',
          retryable: false,
        });
        return 'stop';
      }
      const steps = this.store.steps(taskId);
      const step = steps.find((s) => s.state === 'pending' || s.state === 'running');
      if (!step) break;
      const msgs = messagesFor(task.language);

      const blocked = step.dependsOn.some((dependency) => {
        const found = steps.find((s) => s.planStepId === dependency);
        return found !== undefined && found.state !== 'done';
      });
      if (blocked) {
        this.store.updateStep(step.id, { state: 'skipped', error: msgs.skippedDependency });
        this.event(taskId, 'STEP_FAILED', { stepId: step.id, skipped: true });
        this.changed(taskId);
        if (!step.optional) {
          this.failTask(taskId, {
            code: 'GOAL_NOT_MET',
            message: `${step.title}: ${msgs.skippedDependency}`,
            retryable: false,
          });
          return 'stop';
        }
        continue;
      }

      const started = this.now();
      this.store.updateStep(step.id, {
        state: 'running',
        attempts: step.attempts + 1,
        startedAt: started,
        error: undefined,
      });
      this.event(taskId, 'STEP_STARTED', {
        stepId: step.id,
        title: step.title,
        attempt: step.attempts + 1,
      });
      this.changed(taskId);

      const outcome = await this.attemptStep(taskId, run, task, plan, {
        ...step,
        attempts: step.attempts + 1,
      });

      if (outcome.kind === 'done') {
        this.store.updateStep(step.id, {
          state: 'done',
          summary: outcome.summary,
          evidence: outcome.evidence || undefined,
          unverified: outcome.unverified,
          error: undefined,
          retryNote: undefined,
          completedAt: this.now(),
        });
        this.event(taskId, 'STEP_COMPLETED', {
          stepId: step.id,
          unverified: outcome.unverified,
        });
        this.changed(taskId);
        continue;
      }

      if (outcome.kind === 'question') {
        // Not an attempt: the step goes back to pending and the question is asked.
        this.store.updateStep(step.id, { state: 'pending', attempts: step.attempts });
        this.ask(taskId, outcome.question, 'EXECUTING');
        return 'stop';
      }

      if (outcome.kind === 'declined') {
        this.store.updateStep(step.id, {
          state: 'skipped',
          error: outcome.unanswered ? msgs.unanswered : msgs.declined,
          completedAt: this.now(),
        });
        this.event(taskId, 'USER_DECLINED', {
          stepId: step.id,
          tool: outcome.tool,
          ...(outcome.unanswered ? { unanswered: true } : {}),
        });
        const pending: PendingRequest = {
          kind: 'declined',
          tool: outcome.tool,
          summary: outcome.summary,
          ...(outcome.unanswered ? { unanswered: true } : {}),
        };
        this.transition(taskId, 'WAITING_FOR_USER', { pending, resumeState: 'EXECUTING' });
        return 'stop';
      }

      // failed
      this.event(taskId, 'STEP_FAILED', {
        stepId: step.id,
        attempt: step.attempts + 1,
        message: clip(outcome.message, 300),
        ...(outcome.code ? { code: outcome.code } : {}),
      });
      this.transition(taskId, 'ERROR');
      this.transition(taskId, 'RECOVERY');
      const attemptsUsed = step.attempts + 1;
      if (outcome.retryable && attemptsUsed < this.limits.maxAttemptsPerStep) {
        this.store.updateStep(step.id, {
          state: 'pending',
          error: outcome.message,
          retryNote: outcome.note ?? retryNoteFor(attemptsUsed + 1, outcome.message),
        });
        this.event(taskId, 'STEP_RETRY', { stepId: step.id, attempt: attemptsUsed + 1 });
        this.transition(taskId, 'RETRY');
        await this.pauseAware(
          taskId,
          run,
          (this.deps.backoffMs ?? defaultBackoff)(attemptsUsed, outcome.code),
        );
        this.transition(taskId, 'EXECUTING');
        continue;
      }
      this.store.updateStep(step.id, {
        state: 'failed',
        error: outcome.message,
        completedAt: this.now(),
      });
      this.changed(taskId);
      if (step.optional) {
        this.transition(taskId, 'RETRY');
        this.transition(taskId, 'EXECUTING');
        continue;
      }
      this.failTask(taskId, {
        code: outcome.code ?? 'TOOL_EXECUTION_FAILED',
        message: `${step.title}: ${outcome.message}`,
        retryable: false,
      });
      return 'stop';
    }
    this.transition(taskId, 'VERIFYING');
    return 'verify';
  }

  /** Waits `ms` unless the user cancels or pauses first (then the usual safe-point handling applies). */
  private async pauseAware(taskId: string, run: Run, ms: number): Promise<void> {
    if (ms > 0) {
      const signal = AbortSignal.any([run.signal, run.pause.signal]);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    this.checkpoint(taskId, run);
  }

  private async attemptStep(
    taskId: string,
    run: Run,
    task: TaskRecord,
    plan: Plan,
    step: StepRecord,
  ): Promise<StepOutcome> {
    const msgs = messagesFor(task.language);
    const ctx = this.promptContext(task);
    const specs = [...this.deps.tools.specs(), finishStepSpec(), askUserSpec()];
    const messages: AIMessage[] = [
      {
        role: 'user',
        content: stepBrief({ task, plan, steps: this.store.steps(taskId), step }),
      },
    ];
    const log: CallLog[] = [];
    let nudged = false;

    for (let round = 0; round < this.limits.maxRoundsPerStep; round += 1) {
      this.checkpoint(taskId, run);
      let turn: ModelTurn;
      try {
        turn = await this.callModel(taskId, run, {
          purpose: 'step',
          system: stepSystemPrompt(ctx),
          messages,
          tools: specs,
          maxTokens: 2048,
        });
      } catch (error) {
        if (error instanceof PauseRequested || run.signal.aborted) throw error;
        const serialized = toSerializedError(error);
        if (serialized.code === 'CANCELLED' || serialized.code === 'LIMIT_EXCEEDED') throw error;
        return {
          kind: 'failed',
          message: serialized.message,
          retryable: serialized.retryable,
          code: serialized.code,
        };
      }

      if (turn.calls.length === 0) {
        if (turn.finishReason === 'length') {
          return { kind: 'failed', message: msgs.cutOff, retryable: true };
        }
        if (nudged) return { kind: 'failed', message: msgs.noOutcome, retryable: true };
        nudged = true;
        messages.push({ role: 'assistant', content: turn.text || '…' });
        messages.push({ role: 'user', content: NUDGE_TO_FINISH });
        continue;
      }

      messages.push({
        role: 'assistant',
        content: [
          ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          ...turn.calls.map((call) => ({
            type: 'tool_call' as const,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        ],
      });

      const alone = turn.calls.length === 1;
      const results: ToolResultPart[] = [];
      for (const [index, call] of turn.calls.entries()) {
        const reply = (content: string, isError = false) =>
          results.push({ type: 'tool_result', toolCallId: call.id, content, isError });

        if (call.name === CONTROL_TOOLS.finishStep || call.name === CONTROL_TOOLS.askUser) {
          if (!alone) {
            reply(
              JSON.stringify({
                ok: false,
                error: `Call ${call.name} on its own, after you have seen the results of your other tool calls.`,
              }),
              true,
            );
            continue;
          }
          if (call.name === CONTROL_TOOLS.finishStep) {
            const parsed = finishStepSchema.safeParse(call.arguments);
            if (!parsed.success) {
              reply(
                JSON.stringify({
                  ok: false,
                  error: 'finish_step needs outcome ("done" or "failed") and a summary.',
                }),
                true,
              );
              continue;
            }
            return this.judgeStep(step, log, parsed.data, msgs);
          }
          const asked = askUserSchema.safeParse(call.arguments);
          if (!asked.success) {
            reply(JSON.stringify({ ok: false, error: 'ask_user needs a question.' }), true);
            continue;
          }
          if (this.require(taskId).usage.questions >= this.limits.maxQuestions) {
            reply(
              JSON.stringify({
                ok: false,
                error:
                  'You cannot ask the user anything more. Do what you reasonably can with what you know, or report "failed" and say what is missing.',
              }),
              true,
            );
            continue;
          }
          return { kind: 'question', question: asked.data.question };
        }

        if (index >= this.limits.maxToolCallsPerTurn) {
          reply(
            JSON.stringify({
              ok: false,
              error: 'Too many tool calls at once. Do them one or two at a time.',
            }),
            true,
          );
          continue;
        }
        if (this.require(taskId).usage.toolCalls >= this.limits.maxToolCallsPerTask) {
          throw new AllayaError(msgs.limitTools(this.limits.maxToolCallsPerTask), {
            code: 'LIMIT_EXCEEDED',
          });
        }

        const result = await this.deps.tools.execute(
          { id: newId('call'), name: call.name, arguments: call.arguments },
          {
            signal: run.signal,
            language: task.language,
            taskId,
            stepId: step.id,
            onProgress: (progress) => this.onToolProgress(taskId, step.id, progress),
          },
        );
        if (run.signal.aborted) throw cancelledError();
        const facts = this.deps.tools.facts(call.name);
        const entry: CallLog = {
          tool: call.name,
          readOnly: facts?.readOnly ?? false,
          files: facts?.category === 'files',
          ok: result.ok,
          status: result.status,
          verification: result.verification,
          summary: result.auditSummary ?? result.summary ?? call.name,
          evidence: result.evidence,
          errorMessage: result.error?.message,
          errorCode: result.error?.code,
        };
        log.push(entry);
        this.countCall(taskId, entry, result.risk);
        const formatted = formatResultForModel(result);
        reply(formatted.content, formatted.isError);

        if (result.status === 'rejected') {
          // The person said no. The step stops here — the model is not given the chance to find a way around it.
          return {
            kind: 'declined',
            tool: call.name,
            summary: result.summary,
            unanswered: result.error?.details?.['reason'] === 'expired',
          };
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return {
      kind: 'failed',
      message: msgs.tooManyRounds(this.limits.maxRoundsPerStep),
      retryable: true,
    };
  }

  /**
   * The model says how the step went; the tool results decide whether that is believed. A step is not done
   * because the model says so: something must actually have run, and the last change it tried must have worked.
   */
  private judgeStep(
    step: StepRecord,
    log: readonly CallLog[],
    report: { outcome: 'done' | 'failed'; summary: string },
    msgs: ReturnType<typeof messagesFor>,
  ): StepOutcome {
    const summary = clip(report.summary, 1200);
    if (report.outcome === 'failed') {
      const lastRefusal = [...log].reverse().find((entry) => !entry.ok);
      const final =
        lastRefusal?.status === 'denied' ||
        lastRefusal?.status === 'unsupported' ||
        (lastRefusal?.errorCode !== undefined && FINAL_REFUSALS.has(lastRefusal.errorCode));
      return {
        kind: 'failed',
        message: summary,
        retryable: !final,
        ...(lastRefusal?.errorCode ? { code: lastRefusal.errorCode } : {}),
      };
    }

    if (step.toolHint && log.length === 0) {
      return {
        kind: 'failed',
        message: msgs.noToolRun,
        retryable: true,
        note:
          'You reported the step done without running any tool, so it was not counted. Use the tool that does it, ' +
          'or report "failed" and say why it cannot be done.',
      };
    }
    if (log.length > 0 && !log.some((entry) => entry.ok)) {
      const last = log[log.length - 1]!;
      return {
        kind: 'failed',
        message:
          `${msgs.allCallsFailed} ${last.errorMessage ? clip(last.errorMessage, 200) : ''}`.trim(),
        retryable: !(last.errorCode && FINAL_REFUSALS.has(last.errorCode)),
        ...(last.errorCode ? { code: last.errorCode } : {}),
      };
    }
    const changes = log.filter((entry) => !entry.readOnly);
    const lastFailedChange = changes.map((entry) => entry.ok).lastIndexOf(false);
    if (lastFailedChange !== -1 && !changes.slice(lastFailedChange + 1).some((entry) => entry.ok)) {
      const failed = changes[lastFailedChange]!;
      return {
        kind: 'failed',
        message: msgs.lastChangeFailed(
          `${clip(failed.summary, 120)}${failed.errorMessage ? ` — ${clip(failed.errorMessage, 160)}` : ''}`,
        ),
        retryable: !(failed.errorCode && FINAL_REFUSALS.has(failed.errorCode)),
        ...(failed.errorCode ? { code: failed.errorCode } : {}),
      };
    }
    return {
      kind: 'done',
      summary,
      evidence: evidenceLines(log),
      unverified: changes.some((entry) => entry.ok && entry.verification !== 'verified'),
    };
  }

  private onToolProgress(taskId: string, stepId: string, progress: ExecutionProgress): void {
    switch (progress.type) {
      case 'started':
        this.event(taskId, 'TOOL_STARTED', {
          stepId,
          callId: progress.callId,
          tool: progress.tool,
          risk: progress.risk,
        });
        break;
      case 'awaiting_confirmation':
        this.event(taskId, 'PERMISSION_REQUESTED', {
          stepId,
          callId: progress.callId,
          tool: progress.tool,
          risk: progress.risk,
        });
        break;
      case 'finished': {
        const { result } = progress;
        const type: TaskEventType =
          result.status === 'success'
            ? 'TOOL_COMPLETED'
            : result.status === 'denied'
              ? 'PERMISSION_DENIED'
              : 'TOOL_FAILED';
        this.event(taskId, type, {
          stepId,
          callId: result.callId,
          tool: result.tool,
          status: result.status,
          verification: result.verification,
          ...(result.risk ? { risk: result.risk } : {}),
          summary: clip(result.auditSummary ?? result.summary, 200),
          ...(result.error ? { error: clip(result.error.message, 200) } : {}),
        });
        break;
      }
      case 'running':
        break;
    }
    this.changed(taskId);
  }

  private countCall(taskId: string, entry: CallLog, risk: RiskLevel | undefined): void {
    const task = this.require(taskId);
    const changed = entry.ok && !entry.readOnly;
    this.store.update(taskId, {
      usage: { ...task.usage, toolCalls: task.usage.toolCalls + 1 },
      actionCount: task.actionCount + (changed ? 1 : 0),
      filesChanged: task.filesChanged + (changed && entry.files ? 1 : 0),
      riskLevel: risk ? maxRisk(task.riskLevel, risk) : task.riskLevel,
    });
  }

  // ── the answer ────────────────────────────────────────────────────────────
  private async finish(taskId: string, run: Run): Promise<void> {
    this.event(taskId, 'VERIFICATION_STARTED');
    const task = this.require(taskId);
    const plan = task.plan!;
    const msgs = messagesFor(task.language);
    const steps = this.store.steps(taskId);
    const done = steps.filter((step) => step.state === 'done');
    const notDone = steps.filter((step) => !step.optional && step.state !== 'done');
    const unverified = done.filter((step) => step.unverified).length;

    let text: string;
    let judged: 'achieved' | 'partial' | 'not_achieved' = 'achieved';
    if (steps.length === 1 && steps[0]!.state === 'done') {
      text = steps[0]!.summary ?? steps[0]!.title;
    } else {
      try {
        const turn = await this.callModel(taskId, run, {
          purpose: 'summary',
          system: summarySystemPrompt(this.promptContext(task)),
          messages: [
            {
              role: 'user',
              content: summaryUserMessage({ request: task.request, plan, steps }),
            },
          ],
          tools: [finishTaskSpec()],
          forceTool: CONTROL_TOOLS.finishTask,
          maxTokens: 1500,
        });
        const call = turn.calls.find((c) => c.name === CONTROL_TOOLS.finishTask);
        const parsed = call ? finishTaskSchema.safeParse(call.arguments) : undefined;
        if (!parsed?.success)
          throw new AllayaError('No usable final answer', { code: 'PROVIDER_ERROR' });
        text = parsed.data.summary;
        judged = parsed.data.outcome;
      } catch (error) {
        if (error instanceof PauseRequested || run.signal.aborted) throw error;
        if (toSerializedError(error).code === 'CANCELLED') throw error;
        // The answer is only words: without a model, say what happened from the record.
        text = [
          msgs.stepsDone(done.length, steps.length),
          ...done.map(
            (step) => `• ${step.title}${step.summary ? ` — ${clip(step.summary, 200)}` : ''}`,
          ),
        ].join('\n');
      }
    }

    // The recorded results outrank the model's opinion: it can only make the verdict stricter.
    let outcome: 'achieved' | 'partial' | 'not_achieved' = judged;
    if (notDone.length > 0) outcome = done.length > 0 ? 'partial' : 'not_achieved';
    else if (steps.every((step) => step.state !== 'done')) outcome = 'not_achieved';

    const extra: string[] = [];
    if (notDone.length > 0) extra.push(msgs.notDone(notDone.map((step) => step.title).join('; ')));
    if (unverified > 0) extra.push(msgs.unverified(unverified));
    const resultSummary = [text, ...extra].join('\n\n');
    this.event(taskId, 'VERIFICATION_COMPLETED', { outcome, unverified });

    if (outcome === 'not_achieved') {
      this.failTask(
        taskId,
        { code: 'GOAL_NOT_MET', message: msgs.goalNotMet, retryable: false },
        resultSummary,
      );
      return;
    }
    this.transition(taskId, 'COMPLETED', {
      outcome: outcome === 'partial' ? 'partial' : 'achieved',
      resultSummary,
      pending: undefined,
      resumeState: undefined,
    });
    this.event(taskId, 'TASK_COMPLETED', { outcome });
  }

  // ── ending a task another way ────────────────────────────────────────────
  private failTask(taskId: string, error: SerializedError, resultSummary?: string): void {
    const task = this.store.get(taskId);
    if (!task || isTerminal(task.state)) return;
    const msgs = messagesFor(task.language);
    for (const step of this.store.steps(taskId)) {
      if (step.state === 'running') {
        this.store.updateStep(step.id, { state: 'failed', error: error.message });
      } else if (step.state === 'pending') {
        this.store.updateStep(step.id, { state: 'skipped', error: msgs.skippedEarlierFailed });
      }
    }
    const done = this.store.steps(taskId).filter((step) => step.state === 'done').length;
    const total = this.store.steps(taskId).length;
    this.transition(taskId, 'FAILED', {
      error,
      pending: undefined,
      resumeState: undefined,
      resultSummary:
        resultSummary ??
        (total > 0 ? `${msgs.stepsDone(done, total)} ${error.message}` : error.message),
    });
    this.event(taskId, 'TASK_FAILED', { code: error.code, message: clip(error.message, 300) });
  }

  private cancelTask(taskId: string, reason?: string): void {
    const task = this.store.get(taskId);
    if (!task || isTerminal(task.state)) return;
    for (const step of this.store.steps(taskId)) {
      if (step.state === 'running' || step.state === 'pending') {
        this.store.updateStep(step.id, { state: 'cancelled' });
      }
    }
    this.transition(taskId, 'CANCELLED', { pending: undefined, resumeState: undefined });
    this.event(taskId, 'TASK_CANCELLED', reason ? { reason: clip(reason, 200) } : undefined);
  }

  private applyPause(taskId: string, reason: 'user' | 'interrupted'): void {
    const task = this.store.get(taskId);
    if (!task || isTerminal(task.state) || task.state === 'PAUSED') return;
    // Transient recovery states are not where work resumes: a step retry goes back to executing.
    const from: TaskState =
      task.state === 'ERROR' || task.state === 'RECOVERY' || task.state === 'RETRY'
        ? 'EXECUTING'
        : task.state;
    // A step that was mid-flight goes back to pending, and is told it may be partly done.
    for (const step of this.store.steps(taskId)) {
      if (step.state === 'running') {
        this.store.updateStep(step.id, {
          state: 'pending',
          attempts: Math.max(0, step.attempts - 1),
          retryNote: INTERRUPTED_NOTE,
        });
      }
    }
    const keepPending = task.state === 'WAITING_FOR_USER';
    this.transition(taskId, 'PAUSED', {
      pausedFrom: from,
      pauseReason: reason,
      ...(keepPending ? {} : { pending: undefined, resumeState: undefined }),
    });
    this.event(taskId, 'TASK_PAUSED', { reason });
  }

  // ── the model ─────────────────────────────────────────────────────────────
  private async callModel(taskId: string, run: Run, input: ModelInput): Promise<ModelTurn> {
    this.checkpoint(taskId, run);
    const signal = AbortSignal.any([run.signal, run.pause.signal]);
    let turn: ModelTurn;
    try {
      const complexity = this.require(taskId).complexity;
      turn = await this.deps.model.turn(
        complexity && !input.complexity ? { ...input, complexity } : input,
        signal,
      );
    } catch (error) {
      if (run.signal.aborted) throw cancelledError();
      if (run.pause.signal.aborted) throw new PauseRequested();
      throw error;
    }
    if (run.signal.aborted) throw cancelledError();
    const task = this.require(taskId);
    this.store.update(taskId, {
      usage: {
        ...task.usage,
        modelTurns: task.usage.modelTurns + 1,
        inputTokens: task.usage.inputTokens + turn.usage.inputTokens,
        outputTokens: task.usage.outputTokens + turn.usage.outputTokens,
      },
      ...(turn.modelLabel ? { modelLabel: turn.modelLabel } : {}),
    });
    if (run.pause.signal.aborted) throw new PauseRequested();
    return turn;
  }

  private promptContext(task: TaskRecord): PromptContext {
    return {
      language: task.language,
      now: new Date(this.now()),
      userName: this.deps.userName?.(),
      memory: this.deps.memory?.(task),
    };
  }

  // ── plumbing ──────────────────────────────────────────────────────────────
  private transition(
    taskId: string,
    to: TaskState,
    patch: Partial<Omit<TaskRecord, 'id' | 'createdAt'>> = {},
  ): TaskRecord {
    const task = this.require(taskId);
    assertTransition(task.state, to);
    const next = this.store.update(taskId, {
      ...patch,
      state: to,
      ...(isTerminal(to) ? { completedAt: this.now() } : {}),
    });
    this.event(taskId, 'STATE_CHANGED', { from: task.state, to });
    this.changed(taskId);
    return next;
  }

  private event(taskId: string, type: TaskEventType, payload?: Record<string, unknown>): void {
    const event = this.store.appendEvent(taskId, type, payload);
    this.deps.onEvent?.(event);
  }

  private changed(taskId: string): void {
    this.deps.onChange?.(taskId);
  }

  private require(taskId: string): TaskRecord {
    const task = this.store.get(taskId);
    if (!task) throw new AllayaError('Task not found', { code: 'NOT_FOUND' });
    return task;
  }
}

/** One line per action, so the record shows what was checked and what was not. */
function evidenceLines(log: readonly CallLog[]): string {
  const lines = log.map((entry) => {
    const what = clip(entry.summary, 120);
    if (!entry.ok) {
      return `✗ ${what}${entry.errorMessage ? ` — ${clip(entry.errorMessage, 120)}` : ''}`;
    }
    if (entry.readOnly) return `• ${what}`;
    return entry.verification === 'verified'
      ? `✓ ${what}${entry.evidence ? ` — ${clip(entry.evidence, 120)}` : ''}`
      : `? ${what} — could not be confirmed`;
  });
  return lines.slice(-MAX_EVIDENCE_LINES).join('\n');
}
