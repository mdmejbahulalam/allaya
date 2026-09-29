import { z } from 'zod';
import { riskSchema } from './tools';
import { noPayload, spec } from './common';

/** One line of the record of what Allaya did (or was refused, or was stopped from doing). */
export const activityEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  actor: z.enum(['allaya', 'user', 'system']),
  /** The tool involved, when one was. */
  tool: z.string().optional(),
  /** What happened, in a sentence (never typed text, file contents or secrets). */
  action: z.string(),
  result: z.enum(['success', 'failure', 'denied', 'cancelled', 'pending', 'info']),
  risk: riskSchema.optional(),
  /** How permission was settled: allowed, allowed by the user, denied, denied by the user, not required. */
  permission: z.string().optional(),
  error: z.string().optional(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const ACTIVITY_PAGE_MAX = 200;
export const ACTIVITY_QUERY_MAX = 100;

export const activityListRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(ACTIVITY_PAGE_MAX).optional(),
    /** Only entries older than this time (the `timestamp` of the last one already shown). */
    before: z.number().int().nonnegative().optional(),
    result: z.enum(['success', 'failure', 'denied', 'cancelled']).optional(),
    risk: riskSchema.optional(),
    /** Words to look for in what happened and the tool name. */
    query: z.string().trim().max(ACTIVITY_QUERY_MAX).optional(),
  })
  .strict();

export const activityListSchema = z.object({
  entries: z.array(activityEntrySchema),
  hasMore: z.boolean(),
  /** Entries older than this many days are removed at start-up. */
  retentionDays: z.number(),
});
export type ActivityList = z.infer<typeof activityListSchema>;

export const activityContract = {
  invoke: {
    'activity:list': spec(activityListRequestSchema.optional(), activityListSchema),
    /** Removes the whole record. Only the person can ask (the screen asks first); no tool can. */
    'activity:clear': spec(noPayload, z.object({ removed: z.number() })),
  },
  events: {
    'activity:changed': z.object({}),
  },
} as const;
