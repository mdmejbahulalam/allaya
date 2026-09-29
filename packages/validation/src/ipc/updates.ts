import { z } from 'zod';
import { noPayload, okSchema, spec } from './common';

/** Where an update stands. The person always decides when to restart; nothing installs by itself while Allaya is busy. */
export const updateStatusSchema = z.discriminatedUnion('state', [
  /** Development runs, tests and portable copies have no update feed. */
  z.object({ state: z.literal('unsupported') }),
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('up_to_date'), checkedAt: z.number() }),
  z.object({ state: z.literal('available'), version: z.string().max(64) }),
  z.object({
    state: z.literal('downloading'),
    version: z.string().max(64),
    percent: z.number().min(0).max(100),
  }),
  z.object({ state: z.literal('ready'), version: z.string().max(64) }),
  z.object({ state: z.literal('error'), reason: z.enum(['network', 'unknown']) }),
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const updatesContract = {
  invoke: {
    'updates:getStatus': spec(noPayload, updateStatusSchema),
    'updates:check': spec(noPayload, updateStatusSchema),
    'updates:download': spec(noPayload, updateStatusSchema),
    /** Restarts Allaya into the new version. Refused while Allaya is working. */
    'updates:install': spec(noPayload, okSchema),
  },
  events: {
    'updates:changed': updateStatusSchema,
  },
} as const;
