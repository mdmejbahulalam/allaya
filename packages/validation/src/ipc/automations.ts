import { z } from 'zod';
import { AUTOMATION_RUN_STATUSES } from '@allaya/types';
import {
  automationInputSchema,
  automationOptionsSchema,
  automationTriggerSchema,
} from '../automation';
import { idSchema, noPayload, okSchema, spec } from './common';

export const automationRunSchema = z.object({
  id: z.string(),
  status: z.enum(AUTOMATION_RUN_STATUSES),
  triggeredBy: z.enum(['schedule', 'manual', 'event']),
  taskId: z.string().optional(),
  /** Why nothing started, or a remark on how it ended — a code the screen turns into words. */
  note: z
    .enum(['missed', 'still_running', 'failed_to_start', 'partial', 'needs_you', 'paused'])
    .optional(),
  /** What went wrong, when something did. */
  error: z.string().optional(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
});
export type AutomationRunView = z.infer<typeof automationRunSchema>;

export const automationSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  instruction: z.string(),
  enabled: z.boolean(),
  trigger: automationTriggerSchema,
  options: automationOptionsSchema,
  nextRunAt: z.number().optional(),
  lastRunAt: z.number().optional(),
  lastRun: automationRunSchema.optional(),
  /** Runs in a row that failed; three in a row switch the automation off. */
  consecutiveFailures: z.number(),
  /** Something the person should know: the folder cannot be read, or it kept failing and switched itself off. */
  problem: z.enum(['cannot_watch', 'too_many_failures']).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AutomationView = z.infer<typeof automationSchema>;

export const automationsOverviewSchema = z.object({
  automations: z.array(automationSchema),
  /** The emergency stop paused every schedule; nothing starts by itself until this is switched off. */
  paused: z.boolean(),
  limit: z.number(),
});
export type AutomationsOverview = z.infer<typeof automationsOverviewSchema>;

const automationId = z.object({ id: idSchema });

export const automationsContract = {
  invoke: {
    'automations:list': spec(noPayload, automationsOverviewSchema),
    'automations:runs': spec(
      z.object({ id: idSchema, limit: z.number().int().min(1).max(100).optional() }),
      z.array(automationRunSchema),
    ),
    'automations:create': spec(
      automationInputSchema.extend({ enabled: z.boolean().optional() }),
      automationSchema,
    ),
    'automations:update': spec(
      z.object({ id: idSchema, changes: automationInputSchema }),
      automationSchema,
    ),
    'automations:setEnabled': spec(
      z.object({ id: idSchema, enabled: z.boolean() }),
      automationSchema,
    ),
    /** Starts a run now, whatever the schedule says (and even if the automation is switched off). */
    'automations:runNow': spec(automationId, automationRunSchema),
    'automations:delete': spec(automationId, okSchema),
    /** Lets schedules start things again after the emergency stop paused them. */
    'automations:setPaused': spec(z.object({ paused: z.boolean() }), okSchema),
  },
  events: {
    'automations:changed': z.object({}),
  },
} as const;
