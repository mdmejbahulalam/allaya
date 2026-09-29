import { AGENT_STATUSES } from '@allaya/types';
import { z } from 'zod';
import { noPayload, spec } from './common';

export const agentStatusEventSchema = z.object({
  status: z.enum(AGENT_STATUSES),
  detail: z.string().max(200).optional(),
  /** Number of runs currently active (drives the always-visible STOP control). */
  activeRuns: z.number().int().nonnegative(),
});
export type AgentStatusEvent = z.infer<typeof agentStatusEventSchema>;

export const agentContract = {
  invoke: {
    /** Emergency stop: cancels every active run as quickly as practical. */
    'agent:stop': spec(noPayload, z.object({ cancelled: z.number().int().nonnegative() })),
    'agent:getStatus': spec(noPayload, agentStatusEventSchema),
  },
  events: {
    'agent:status': agentStatusEventSchema,
  },
} as const;
