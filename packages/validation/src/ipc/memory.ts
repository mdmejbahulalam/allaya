import { z } from 'zod';
import { MEMORY_CATEGORIES, MEMORY_SOURCES } from '@allaya/types';
import { memoryInputSchema } from '../memory';
import { idSchema, noPayload, okSchema, spec } from './common';

export const memorySchema = z.object({
  id: z.string(),
  category: z.enum(MEMORY_CATEGORIES),
  key: z.string(),
  value: z.string(),
  /** Who put it here: the person, Allaya on the person's approval, or the system. */
  source: z.enum(MEMORY_SOURCES),
  /** Where it came from, in words the screen can show ("chat"), when it is known. */
  origin: z.enum(['screen', 'chat']).optional(),
  /** How many replies have used it, and when last. */
  useCount: z.number(),
  lastUsedAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type MemoryView = z.infer<typeof memorySchema>;

export const memoryOverviewSchema = z.object({
  memories: z.array(memorySchema),
  /** Off: nothing is remembered, and nothing already remembered is given to the AI. */
  enabled: z.boolean(),
  limit: z.number(),
});
export type MemoryOverview = z.infer<typeof memoryOverviewSchema>;

export const memoryContract = {
  invoke: {
    'memory:list': spec(noPayload, memoryOverviewSchema),
    'memory:create': spec(memoryInputSchema, memorySchema),
    'memory:update': spec(z.object({ id: idSchema, changes: memoryInputSchema }), memorySchema),
    'memory:delete': spec(z.object({ id: idSchema }), okSchema),
    'memory:deleteAll': spec(noPayload, z.object({ removed: z.number() })),
    'memory:setEnabled': spec(z.object({ enabled: z.boolean() }), okSchema),
    /** Asks the person where to save a copy (a system dialog in the main process); `saved` is false if they cancel. */
    'memory:export': spec(noPayload, z.object({ saved: z.boolean() })),
  },
  events: {
    'memory:changed': z.object({}),
  },
} as const;
