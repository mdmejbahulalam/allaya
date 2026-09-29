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

/** Whether the system-wide emergency-stop key is really registered with the operating system. */
export const emergencyStopStatusSchema = z.object({
  /** The key combination the person chose (Electron accelerator form, e.g. `Ctrl+Shift+Escape`). */
  accelerator: z.string(),
  registered: z.boolean(),
  /** Why not: another program holds the key, the combination is not valid, or this system cannot do it. */
  reason: z.enum(['in_use', 'invalid', 'unavailable']).optional(),
});
export type EmergencyStopStatus = z.infer<typeof emergencyStopStatusSchema>;

export const agentContract = {
  invoke: {
    /** Emergency stop: cancels every active run as quickly as practical. */
    'agent:stop': spec(noPayload, z.object({ cancelled: z.number().int().nonnegative() })),
    'agent:getStatus': spec(noPayload, agentStatusEventSchema),
    'agent:getSafety': spec(noPayload, z.object({ emergencyStop: emergencyStopStatusSchema })),
  },
  events: {
    'agent:status': agentStatusEventSchema,
    /** The emergency-stop key was re-registered (the person chose another one): ask again for its status. */
    'agent:safetyChanged': z.object({}),
    /** The system-wide emergency-stop key was pressed (the window may be hidden or unfocused). */
    'agent:stopped': z.object({
      cancelled: z.number().int().nonnegative(),
      via: z.literal('shortcut'),
    }),
  },
} as const;
