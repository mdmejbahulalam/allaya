import { z } from 'zod';
import { workflowSchema } from './workflow';

/**
 * What starts an automation. Times are the computer's local time. Kept in one place so the scheduler, the tools the
 * model may call, the database and the screen all agree on what a valid trigger is.
 */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour');

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export const automationTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
  z
    .object({
      kind: z.literal('once'),
      /** Epoch milliseconds. */
      at: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      everyMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('daily'),
      time: clock,
      /** 0 = Sunday … 6 = Saturday. */
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
  z
    .object({
      kind: z.literal('monthly'),
      /** Capped at 28 so every month has it. */
      day: z.number().int().min(1).max(28),
      time: clock,
    })
    .strict(),
  z
    .object({
      kind: z.literal('new_file'),
      /** A folder Allaya may use, as the file tools name it (`Downloads`, `Documents/Invoices`). */
      folder: z.string().trim().min(1).max(1024),
    })
    .strict(),
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

export const automationOptionsSchema = z
  .object({
    /** What to do when the moment passed while Allaya was closed. Never runs late by surprise unless asked. */
    missed: z.enum(['skip', 'run_once']).default('skip'),
    /** Show the plan of every run and wait for a yes. */
    planFirst: z.boolean().default(false),
  })
  .strict();
export type AutomationOptions = z.infer<typeof automationOptionsSchema>;

export const MAX_AUTOMATIONS = 20;
export const MAX_INSTRUCTION_CHARS = 2000;

export const automationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    /**
     * What to do each time, in the person's own words. It runs as a task with the person's permissions. May be empty
     * when there is a workflow (which is checked where the automation is saved).
     */
    instruction: z.string().trim().max(MAX_INSTRUCTION_CHARS),
    /** Several steps instead of one instruction: conditions, loops and approvals. Made on the screen, never by the model. */
    workflow: workflowSchema.optional(),
    trigger: automationTriggerSchema,
    options: automationOptionsSchema.partial().optional(),
  })
  .strict();
export type AutomationInput = z.infer<typeof automationInputSchema>;
