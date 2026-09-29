import { z } from 'zod';
import { PERMISSION_MODES, PERMISSION_SUBJECTS, RISK_LEVELS } from '@allaya/types';
import { spec, noPayload, idSchema } from './common';

export const riskSchema = z.enum(RISK_LEVELS);
export const permissionSubjectSchema = z.enum(PERMISSION_SUBJECTS);
export const permissionModeSchema = z.enum(PERMISSION_MODES);

/** A question waiting for the user: exactly what Allaya wants to do, and how risky that is. */
export const confirmationViewSchema = z.object({
  id: z.string(),
  callId: z.string(),
  tool: z.string(),
  risk: riskSchema,
  summary: z.string(),
  subjects: z.array(permissionSubjectSchema),
  /** Where an approval is accepted from. */
  channels: z.array(z.enum(['ui', 'voice', 'text'])),
  conversationId: z.string().optional(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type ConfirmationView = z.infer<typeof confirmationViewSchema>;

/** One action in a reply's timeline (persisted with the assistant message). */
export const actionRecordSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  summary: z.string(),
  status: z.enum([
    'running',
    'awaiting_confirmation',
    'success',
    'failed',
    'denied',
    'rejected',
    'cancelled',
    'invalid',
    'unknown_tool',
    'unsupported',
  ]),
  risk: riskSchema.optional(),
  verification: z.enum(['verified', 'failed', 'unverified', 'not_applicable']).optional(),
  evidence: z.string().optional(),
  error: z.string().optional(),
});
export type ActionRecord = z.infer<typeof actionRecordSchema>;

export const permissionEntrySchema = z.object({
  subject: permissionSubjectSchema,
  mode: permissionModeSchema,
  defaultMode: permissionModeSchema,
  /** Sensitive actions can never be set to "always allow". */
  sensitive: z.boolean(),
});
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;

export const toolsContract = {
  invoke: {
    'tools:listPendingConfirmations': spec(noPayload, z.array(confirmationViewSchema)),
    'tools:respondConfirmation': spec(
      z.object({ id: idSchema, decision: z.enum(['approved', 'rejected']) }),
      z.object({ accepted: z.boolean() }),
    ),
    'permissions:list': spec(noPayload, z.array(permissionEntrySchema)),
    'permissions:set': spec(
      z.object({ subject: permissionSubjectSchema, mode: permissionModeSchema }),
      z.array(permissionEntrySchema),
    ),
    /** Puts every permission back to its cautious default. */
    'permissions:reset': spec(noPayload, z.array(permissionEntrySchema)),
  },
  events: {
    'tools:confirmationRequested': confirmationViewSchema,
    'tools:confirmationResolved': z.object({
      id: z.string(),
      decision: z.enum(['approved', 'rejected', 'expired', 'cancelled']),
    }),
    /** Live progress of an action inside a reply. */
    'tools:activity': z.object({
      conversationId: z.string(),
      messageId: z.string(),
      action: actionRecordSchema,
    }),
  },
} as const;
