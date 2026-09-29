import { z } from 'zod';
import {
  AGENT_PHASES,
  PERMISSION_SUBJECTS,
  RISK_LEVELS,
  STEP_STATES,
  TASK_COMPLEXITIES,
  TASK_EVENT_TYPES,
  TASK_SOURCES,
  TASK_STATES,
} from '@allaya/types';
import { idSchema, noPayload, okSchema, spec } from './common';

export const MAX_TASK_REQUEST_CHARS = 8_000;

/** What a task is waiting for the person to do. */
export const taskPendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan_approval') }),
  z.object({ kind: z.literal('question'), question: z.string() }),
  z.object({
    kind: z.literal('declined'),
    tool: z.string(),
    summary: z.string(),
    /** Nobody answered the question in time (as opposed to the person saying no). */
    unanswered: z.boolean().optional(),
  }),
]);
export type TaskPendingView = z.infer<typeof taskPendingSchema>;

export const taskSummarySchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  title: z.string(),
  state: z.enum(TASK_STATES),
  /** The coarse phase shown by the status pill. */
  phase: z.enum(AGENT_PHASES),
  source: z.enum(TASK_SOURCES),
  complexity: z.enum(TASK_COMPLEXITIES).optional(),
  language: z.enum(['bn', 'en']),
  planFirst: z.boolean(),
  riskLevel: z.enum(RISK_LEVELS),
  resultSummary: z.string().optional(),
  /** For a completed task: everything, or only part of it. */
  outcome: z.enum(['achieved', 'partial']).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  filesChanged: z.number(),
  actionCount: z.number(),
  stepCount: z.number(),
  stepsDone: z.number(),
  pending: taskPendingSchema.optional(),
  pauseReason: z.enum(['user', 'interrupted']).optional(),
  /** Running right now. */
  running: z.boolean(),
  /** Started, but another task is running first. */
  queued: z.boolean(),
  modelLabel: z.string().optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  updatedAt: z.number(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskStepSchema = z.object({
  id: z.string(),
  position: z.number(),
  planStepId: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  expected: z.string().optional(),
  toolHint: z.string().optional(),
  optional: z.boolean(),
  dependsOn: z.array(z.string()),
  state: z.enum(STEP_STATES),
  attempts: z.number(),
  /** What the model reported it did. */
  summary: z.string().optional(),
  /** What the tools independently showed. */
  evidence: z.string().optional(),
  /** Something was done that could not be independently confirmed. */
  unverified: z.boolean(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
});
export type TaskStepView = z.infer<typeof taskStepSchema>;

export const taskEventSchema = z.object({
  id: z.string(),
  seq: z.number(),
  type: z.enum(TASK_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number(),
});
export type TaskEventView = z.infer<typeof taskEventSchema>;

export const taskAssessmentSchema = z.object({
  risk: z.enum(RISK_LEVELS),
  tools: z.array(z.string()),
  subjects: z.array(z.enum(PERMISSION_SUBJECTS)),
  readOnly: z.boolean(),
  needsApproval: z.boolean(),
  reasons: z.array(z.enum(['requested', 'many_steps', 'risky_tool', 'sensitive_subject'])),
});
export type TaskAssessmentView = z.infer<typeof taskAssessmentSchema>;

export const taskDetailSchema = z.object({
  task: taskSummarySchema,
  request: z.string(),
  plan: z.object({ summary: z.string(), successCriteria: z.string().optional() }).optional(),
  steps: z.array(taskStepSchema),
  events: z.array(taskEventSchema),
  assessment: taskAssessmentSchema.optional(),
  usage: z.object({
    toolCalls: z.number(),
    modelTurns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    elapsedMs: z.number(),
  }),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

const taskId = z.object({ id: idSchema });

export const tasksContract = {
  invoke: {
    /** Newest first. */
    'tasks:list': spec(
      z.object({ limit: z.number().int().min(1).max(500).optional() }).optional(),
      z.array(taskSummarySchema),
    ),
    'tasks:get': spec(taskId, taskDetailSchema),
    /** Creates a task and starts it. The plan, approval and progress arrive as `tasks:changed`. */
    'tasks:create': spec(
      z.object({
        request: z.string().trim().min(1).max(MAX_TASK_REQUEST_CHARS),
        /** Show the plan and wait for a yes before doing anything. */
        planFirst: z.boolean().optional(),
      }),
      taskSummarySchema,
    ),
    'tasks:approve': spec(taskId, okSchema),
    'tasks:reject': spec(taskId, okSchema),
    'tasks:answer': spec(
      z.object({ id: idSchema, text: z.string().trim().min(1).max(2_000) }),
      okSchema,
    ),
    'tasks:pause': spec(taskId, z.object({ paused: z.boolean() })),
    /** Continues a paused task, or one waiting after an action was declined. */
    'tasks:resume': spec(taskId, okSchema),
    'tasks:cancel': spec(taskId, z.object({ cancelled: z.boolean() })),
    /** Removes a finished task and its history. */
    'tasks:remove': spec(taskId, z.object({ removed: z.boolean() })),
    'tasks:clearFinished': spec(noPayload, z.object({ removed: z.number().int().nonnegative() })),
  },
  events: {
    /** A task, its steps or its timeline changed. Carries the summary; fetch `tasks:get` for the detail. */
    'tasks:changed': taskSummarySchema,
    'tasks:removed': z.object({ ids: z.array(z.string()) }),
  },
} as const;
