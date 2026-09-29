import type { z } from 'zod';
import type { Logger, SerializedError } from '@allaya/shared';
import type { PermissionDecision, PermissionSubject, RiskLevel, ToolCategory } from '@allaya/types';

export type ToolLanguage = 'bn' | 'en';

/** What a tool gets besides its arguments. Tools never receive credentials or the renderer. */
export interface ToolContext {
  callId: string;
  taskId?: string | undefined;
  /** Aborted by the user's STOP, the emergency stop, a timeout, or shutdown. Long operations must honour it. */
  signal: AbortSignal;
  language: ToolLanguage;
  now: Date;
  logger: Logger;
}

export interface VerificationResult {
  /** `true` only when an *independent* check confirmed the intended effect. */
  verified: boolean;
  /** Human-readable proof, or the reason it could not be confirmed. Shown to the user and given to the model. */
  evidence: string;
}

/**
 * A capability the AI may request. The model chooses the tool and arguments (WHAT); this definition plus the
 * engine decide whether and how it runs (HOW): arguments are validated, risk and permissions are evaluated from
 * the *validated* arguments, and the effect is verified afterwards.
 */
export interface ToolDefinition<S extends z.ZodType = z.ZodType, O = unknown> {
  /** snake_case; unique. Also the name the model sees. */
  name: string;
  /** Written for the model: what it does, when to use it, and what it does NOT do. */
  description: string;
  category: ToolCategory;
  parameters: S;
  /** `true` when the tool only observes. Anything that changes state must be `false`. */
  readOnly: boolean;
  risk: RiskLevel | ((args: z.output<S>) => RiskLevel);
  /** Permission subjects the user must have allowed. */
  requires: readonly PermissionSubject[] | ((args: z.output<S>) => readonly PermissionSubject[]);
  platforms?: readonly NodeJS.Platform[];
  timeoutMs?: number;
  /** One line, in the user's language, saying exactly what will happen. Shown in confirmations and the timeline. */
  describe(args: z.output<S>, language: ToolLanguage): string;
  /**
   * What the *audit log* records instead of `describe` when the description would echo sensitive content (text
   * being typed, clipboard contents). The user still sees the full `describe` line when asked to confirm.
   */
  auditSummary?(args: z.output<S>, language: ToolLanguage): string;
  execute(args: z.output<S>, context: ToolContext): Promise<O>;
  /** Independent check that the effect really happened (re-read the file, list the window, …). */
  verify?(args: z.output<S>, output: O, context: ToolContext): Promise<VerificationResult>;
  /** Arguments as they may be stored in the audit log. Defaults to generic secret redaction. */
  redactArgs?(args: z.output<S>): unknown;
}

/** Preserves argument/output types at the call site; the registry stores the erased form. */
export function defineTool<S extends z.ZodType, O>(
  tool: ToolDefinition<S, O>,
): ToolDefinition<S, O> {
  return tool;
}

export type ExecutionStatus =
  | 'success'
  | 'failed'
  | 'denied'
  | 'rejected'
  | 'cancelled'
  | 'invalid'
  | 'unknown_tool'
  | 'unsupported';

export type VerificationState = 'verified' | 'failed' | 'unverified' | 'not_applicable';

export interface ExecutionResult {
  callId: string;
  tool: string;
  status: ExecutionStatus;
  /** True only when the action ran AND was not contradicted by verification. */
  ok: boolean;
  risk?: RiskLevel;
  permission: PermissionDecision;
  output?: unknown;
  error?: SerializedError;
  verification: VerificationState;
  evidence?: string;
  /** What the tool said it would do (localized). Empty for unknown tools. */
  summary: string;
  /** Privacy-preserving version of `summary` for the audit log, when the tool provides one. */
  auditSummary?: string;
  startedAt: number;
  durationMs: number;
}

/** Live progress for the UI timeline. */
export type ExecutionProgress =
  | { type: 'started'; callId: string; tool: string; summary: string; risk: RiskLevel }
  | {
      type: 'awaiting_confirmation';
      callId: string;
      tool: string;
      summary: string;
      risk: RiskLevel;
    }
  | { type: 'running'; callId: string; tool: string }
  | { type: 'finished'; result: ExecutionResult };

export interface ToolCallRequest {
  /** The model's tool-call id (echoed back in the tool result). */
  id: string;
  name: string;
  arguments: unknown;
}
