import { z } from 'zod';
import { MEMORY_CATEGORIES } from '@allaya/types';

/**
 * What Allaya may remember about the person. One schema for the Memory screen, the database and the tools the model
 * may call, so all three agree on what a memory is.
 */
export const MAX_MEMORIES = 500;
export const MAX_MEMORY_KEY_CHARS = 60;
export const MAX_MEMORY_VALUE_CHARS = 500;

export const memoryInputSchema = z
  .object({
    category: z.enum(MEMORY_CATEGORIES),
    /** A short label for what this is about ("preferred browser", "মায়ের নাম"). */
    key: z.string().trim().min(1).max(MAX_MEMORY_KEY_CHARS),
    /** The thing to remember, in the person's own words. */
    value: z.string().trim().min(1).max(MAX_MEMORY_VALUE_CHARS),
  })
  .strict();
export type MemoryInput = z.infer<typeof memoryInputSchema>;
