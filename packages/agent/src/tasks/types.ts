import type {
  PermissionMode,
  PermissionSubject,
  RiskLevel,
  StepState,
  TaskComplexity,
  TaskEventType,
  TaskSource,
  TaskState,
  ToolCategory,
} from '@allaya/types';
import type { SerializedError } from '@allaya/shared';
import type { AIMessage, FinishReason, ToolCall, Usage } from '@allaya/ai';
import type {
  ExecutionProgress,
  ExecutionResult,
  ModelToolSpec,
  ToolLanguage,
} from '@allaya/tools';
import type { Plan } from './plan';

/** Why the task is waiting for the person. */
export type PendingRequest =
  | { kind: 'plan_approval' }
  | { kind: 'question'; question: string }
  | { kind: 'declined'; tool: string; summary: string; unanswered?: boolean | undefined };

/** Counters the budgets are checked against. Persisted, so they survive a restart. */
export interface TaskUsage {
  toolCalls: number;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  /** How many times the person was asked something. */
  questions: number;
  /** Extra time spent before the last start, in ms (so a resumed task does not restart its clock). */
  elapsedMs: number;
}

export interface TaskRecord {
  id: string;
  conversationId?: string | undefined;
  title: string;
  /** What the person asked, plus anything they added when asked a question. */
  request: string;
  language: 'bn' | 'en';
  state: TaskState;
  source: TaskSource;
  complexity?: TaskComplexity | undefined;
  /** Show the plan and wait for a yes before doing anything. */
  planFirst: boolean;
  riskLevel: RiskLevel;
  plan?: Plan | undefined;
  resultSummary?: string | undefined;
  /** For a completed task: everything was done, or only part of it (the summary says which). */
  outcome?: 'achieved' | 'partial' | undefined;
  error?: SerializedError | undefined;
  filesChanged: number;
  actionCount: number;
  /** For a task waiting on the person: the state it goes to once they answer. */
  resumeState?: TaskState | undefined;
  /** For a paused task: the state it was paused in, and where it goes back to. */
  pausedFrom?: TaskState | undefined;
  pauseReason?: 'user' | 'interrupted' | undefined;
  pending?: PendingRequest | undefined;
  usage: TaskUsage;
  modelLabel?: string | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface StepRecord {
  id: string;
  taskId: string;
  position: number;
  /** The plan's own id for the step (`s1`), used by `dependsOn`. */
  planStepId: string;
  title: string;
  detail?: string | undefined;
  expected?: string | undefined;
  toolHint?: string | undefined;
  optional: boolean;
  dependsOn: string[];
  state: StepState;
  attempts: number;
  /** The model's own report of what it did, then the checked version. */
  summary?: string | undefined;
  /** Independent evidence from the tools (verification results). */
  evidence?: string | undefined;
  /** Something was done that could not be independently confirmed. */
  unverified: boolean;
  error?: string | undefined;
  /** Told to the model at the start of the next attempt (why the last one failed, or that it was interrupted). */
  retryNote?: string | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  seq: number;
  type: TaskEventType;
  payload?: Record<string, unknown> | undefined;
  createdAt: number;
}

/** Persistence, as the orchestrator needs it. The desktop app backs it with SQLite; tests use memory. */
/** What is needed to start a task. */
export interface NewTask {
  id: string;
  conversationId?: string | undefined;
  title: string;
  request: string;
  language: 'bn' | 'en';
  source: TaskSource;
  planFirst: boolean;
  /** A floor for the complexity (a request the chat model already judged multi-step is never run as one step). */
  complexity?: TaskComplexity | undefined;
}

export interface TaskStore {
  create(input: NewTask): TaskRecord;
  get(id: string): TaskRecord | undefined;
  /** Tasks currently in any of these states (startup recovery, the queue). */
  listByState(states: readonly TaskState[]): TaskRecord[];
  update(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'createdAt'>>): TaskRecord;
  steps(taskId: string): StepRecord[];
  replaceSteps(taskId: string, steps: StepRecord[]): void;
  updateStep(id: string, patch: Partial<Omit<StepRecord, 'id' | 'taskId'>>): StepRecord;
  appendEvent(
    taskId: string,
    type: TaskEventType,
    payload?: Record<string, unknown>,
  ): TaskEventRecord;
  /** The recorded timeline, oldest first. */
  events(taskId: string): TaskEventRecord[];
}

export interface ModelTurn {
  text: string;
  calls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
  /** Which model answered, for the record. */
  modelLabel?: string | undefined;
}

export interface ModelInput {
  /** What the call is for, so the app can route it to a suitable model. */
  purpose: 'plan' | 'step' | 'summary';
  system: string;
  /** The size of the task, for choosing a model. */
  complexity?: TaskComplexity | undefined;
  messages: AIMessage[];
  tools?: ModelToolSpec[];
  /** Force one specific tool (structured output). */
  forceTool?: string;
  maxTokens?: number;
}

/** A model, as the orchestrator needs it. It streams under the hood; the orchestrator sees whole turns. */
export interface AgentModel {
  turn(input: ModelInput, signal: AbortSignal): Promise<ModelTurn>;
}

export interface ToolFacts {
  name: string;
  category: ToolCategory;
  description: string;
  /** Worst risk it can have (`varies` when it depends on the arguments). */
  risk: RiskLevel | 'varies';
  readOnly: boolean;
  /** Permission subjects it may need. */
  subjects: readonly PermissionSubject[];
}

/** The tools, as the orchestrator needs them. */
export interface ToolPort {
  /** What the model may use inside a task (never the tool that starts a task). */
  specs(): ModelToolSpec[];
  facts(name: string): ToolFacts | undefined;
  modeFor(subject: PermissionSubject): PermissionMode;
  execute(
    call: { id: string; name: string; arguments: unknown },
    options: {
      signal: AbortSignal;
      language: ToolLanguage;
      taskId: string;
      stepId: string | undefined;
      onProgress?: (progress: ExecutionProgress) => void;
    },
  ): Promise<ExecutionResult>;
}

export interface TaskLimits {
  maxSteps: number;
  maxRoundsPerStep: number;
  maxAttemptsPerStep: number;
  maxToolCallsPerTask: number;
  maxToolCallsPerTurn: number;
  /** How often the person may be asked something during one task. */
  maxQuestions: number;
  maxWallClockMs: number;
  maxPlanRepairs: number;
  /** Plans with more steps than this always ask first. */
  approvalStepThreshold: number;
}

export const DEFAULT_TASK_LIMITS: Readonly<TaskLimits> = {
  maxSteps: 20,
  maxRoundsPerStep: 6,
  maxAttemptsPerStep: 3,
  maxToolCallsPerTask: 80,
  maxToolCallsPerTurn: 6,
  maxQuestions: 3,
  maxWallClockMs: 30 * 60_000,
  maxPlanRepairs: 1,
  approvalStepThreshold: 5,
};
