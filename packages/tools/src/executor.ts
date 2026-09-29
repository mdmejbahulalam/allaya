import type { z } from 'zod';
import { AllayaError, redact, redactString, toSerializedError, type Logger } from '@allaya/shared';
import type {
  PermissionDecision,
  PermissionMode,
  PermissionSubject,
  RiskLevel,
} from '@allaya/types';
import type { ConfirmationBroker } from './confirmation';
import { evaluatePolicy } from './policy';
import type { ToolRegistry } from './registry';
import type {
  ExecutionProgress,
  ExecutionResult,
  ToolCallRequest,
  ToolContext,
  ToolDefinition,
  ToolLanguage,
  VerificationState,
} from './types';

/** Where every attempted action is recorded — including the ones that were refused. */
export interface ToolAuditSink {
  begin(entry: {
    callId: string;
    tool: string;
    taskId?: string | undefined;
    /** Already redacted and size-limited. */
    arguments: unknown;
    risk: RiskLevel;
    summary: string;
  }): void;
  finish(result: ExecutionResult, taskId?: string): void;
}

export interface ExecutorDeps {
  registry: ToolRegistry;
  /** The user's permission mode for a subject (with defaults applied). */
  modeFor: (subject: PermissionSubject) => PermissionMode;
  broker: ConfirmationBroker;
  audit: ToolAuditSink;
  logger: Logger;
  now?: () => Date;
  platform?: NodeJS.Platform;
  defaultTimeoutMs?: number;
  /** Verification is best-effort proof, not a second job: it gets its own short budget. */
  verifyTimeoutMs?: number;
}

export interface ExecuteOptions {
  signal: AbortSignal;
  language: ToolLanguage;
  taskId?: string | undefined;
  conversationId?: string | undefined;
  onProgress?: (progress: ExecutionProgress) => void;
}

const MAX_AUDIT_STRING = 500;

/** Audit-safe copy of the arguments: secrets masked, long text (file contents!) cut. */
function auditArguments(value: unknown): unknown {
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') {
      return node.length > MAX_AUDIT_STRING
        ? `${node.slice(0, MAX_AUDIT_STRING)}… [${node.length} chars]`
        : node;
    }
    if (depth > 6 || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.slice(0, 50).map((item) => walk(item, depth + 1));
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, depth + 1)]));
  };
  return walk(redact(value), 0);
}

/** "path: expected string" — enough for the model to correct itself, without echoing what it sent. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ');
}

/**
 * The single road from "the model asked for a tool" to "something happened on the computer".
 * It never throws: every outcome, including refusals, is a result the agent loop hands back to the model.
 *
 *   look up → validate → platform → risk → permission policy → confirm → run (timeout, cancel)
 *           → verify → audit
 */
export class ToolExecutor {
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly deps: ExecutorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.platform = deps.platform ?? process.platform;
  }

  async execute(call: ToolCallRequest, options: ExecuteOptions): Promise<ExecutionResult> {
    const startedAt = this.now().getTime();
    const base = { callId: call.id, tool: call.name, startedAt };
    const finish = (
      partial: Omit<ExecutionResult, 'callId' | 'tool' | 'startedAt' | 'durationMs'>,
    ): ExecutionResult => {
      const result: ExecutionResult = {
        ...base,
        ...partial,
        durationMs: this.now().getTime() - startedAt,
      };
      options.onProgress?.({ type: 'finished', result });
      try {
        this.deps.audit.finish(result, options.taskId);
      } catch (error) {
        // The action already happened; a lost record is logged loudly but never turns success into a crash.
        this.deps.logger.error('Could not write the final audit record', {
          tool: call.name,
          error: String(error),
        });
      }
      return result;
    };
    const refuse = (
      status: ExecutionResult['status'],
      permission: PermissionDecision,
      error: AllayaError,
      summary = '',
      risk?: RiskLevel,
    ): ExecutionResult =>
      finish({
        status,
        ok: false,
        permission,
        verification: 'not_applicable',
        summary,
        error: toSerializedError(error),
        ...(risk ? { risk } : {}),
      });

    /** No record, no action: if the audit trail cannot be written, nothing runs. */
    const record = (entry: Parameters<ToolAuditSink['begin']>[0]): boolean => {
      try {
        this.deps.audit.begin(entry);
        return true;
      } catch (error) {
        this.deps.logger.error('Could not write the audit record; refusing to run the action', {
          tool: entry.tool,
          error: String(error),
        });
        return false;
      }
    };
    const unrecorded = () =>
      refuse(
        'failed',
        'not_required',
        new AllayaError('The action was not run because it could not be recorded', {
          code: 'INTERNAL',
        }),
      );

    const tool = this.deps.registry.get(call.name);
    if (!tool || (tool.platforms && !tool.platforms.includes(this.platform))) {
      // Unknown tools are still audited: a model inventing tools is worth seeing.
      const ok = record({
        callId: call.id,
        tool: call.name.slice(0, 64),
        taskId: options.taskId,
        arguments: auditArguments(call.arguments),
        risk: 'LOW',
        summary: '',
      });
      if (!ok) return unrecorded();
      return tool
        ? refuse(
            'unsupported',
            'not_required',
            new AllayaError(`"${call.name}" is not available on this operating system`, {
              code: 'UNSUPPORTED_PLATFORM',
            }),
          )
        : refuse(
            'unknown_tool',
            'not_required',
            new AllayaError(`There is no tool named "${call.name.slice(0, 64)}"`, {
              code: 'TOOL_NOT_FOUND',
            }),
          );
    }

    // 1. Validate. Risk and permissions are computed from the *validated* arguments, never the raw ones.
    const parsed = tool.parameters.safeParse(call.arguments);
    if (!parsed.success) {
      const ok = record({
        callId: call.id,
        tool: tool.name,
        taskId: options.taskId,
        arguments: auditArguments(call.arguments),
        risk: 'LOW',
        summary: '',
      });
      if (!ok) return unrecorded();
      return refuse(
        'invalid',
        'not_required',
        new AllayaError(`Invalid arguments — ${describeIssues(parsed.error)}`, {
          code: 'INVALID_INPUT',
        }),
      );
    }
    const args: unknown = parsed.data;

    const risk = typeof tool.risk === 'function' ? tool.risk(args) : tool.risk;
    const subjects = typeof tool.requires === 'function' ? tool.requires(args) : tool.requires;
    let summary: string;
    try {
      summary = tool.describe(args, options.language);
    } catch {
      summary = tool.name; // a broken describe() must never block the safety pipeline
    }
    const redacted = tool.redactArgs ? auditArguments(tool.redactArgs(args)) : auditArguments(args);
    const recorded = record({
      callId: call.id,
      tool: tool.name,
      taskId: options.taskId,
      arguments: redacted,
      risk,
      summary,
    });
    if (!recorded) return unrecorded();
    options.onProgress?.({ type: 'started', callId: call.id, tool: tool.name, summary, risk });

    if (options.signal.aborted) {
      return refuse(
        'cancelled',
        'not_required',
        new AllayaError('Cancelled', { code: 'CANCELLED' }),
        summary,
        risk,
      );
    }

    // 2. Permission policy.
    const decision = evaluatePolicy({ risk, subjects, modeFor: this.deps.modeFor });
    let permission: PermissionDecision;
    if (decision.action === 'deny') {
      return refuse(
        'denied',
        'denied',
        new AllayaError(
          `This is turned off in the user's permission settings (${decision.subject})`,
          {
            code: 'PERMISSION_DENIED',
            details: { subject: decision.subject },
          },
        ),
        summary,
        risk,
      );
    }
    if (decision.action === 'confirm') {
      options.onProgress?.({
        type: 'awaiting_confirmation',
        callId: call.id,
        tool: tool.name,
        summary,
        risk,
      });
      const answer = await this.deps.broker.request(
        {
          callId: call.id,
          tool: tool.name,
          risk,
          summary,
          subjects,
          channels: decision.channels,
          conversationId: options.conversationId,
        },
        options.signal,
      );
      if (answer === 'cancelled') {
        return refuse(
          'cancelled',
          'not_required',
          new AllayaError('Cancelled', { code: 'CANCELLED' }),
          summary,
          risk,
        );
      }
      if (answer !== 'approved') {
        return refuse(
          'rejected',
          'denied_by_user',
          new AllayaError(
            answer === 'expired'
              ? 'The user did not answer the confirmation in time'
              : 'The user declined this action',
            { code: 'CONFIRMATION_REJECTED', details: { reason: answer } },
          ),
          summary,
          risk,
        );
      }
      permission = 'allowed_by_user';
    } else {
      permission = decision.permission;
    }

    // 3. Run — bounded in time, cancellable, and unable to hang the agent loop even if the tool ignores `signal`.
    options.onProgress?.({ type: 'running', callId: call.id, tool: tool.name });
    const timeoutMs = tool.timeoutMs ?? this.deps.defaultTimeoutMs ?? 30_000;
    const controller = new AbortController();
    const onUserAbort = () => controller.abort(new AllayaError('Cancelled', { code: 'CANCELLED' }));
    options.signal.addEventListener('abort', onUserAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new AllayaError(`${tool.name} took longer than ${Math.round(timeoutMs / 1000)}s`, {
            code: 'TIMEOUT',
            retryable: true,
          }),
        ),
      timeoutMs,
    );
    const context: ToolContext = {
      callId: call.id,
      taskId: options.taskId,
      signal: controller.signal,
      language: options.language,
      now: this.now(),
      logger: this.deps.logger.child(tool.name),
    };

    let output: unknown;
    try {
      output = await raceWithAbort(tool.execute(args, context), controller.signal);
    } catch (error) {
      const aborted = controller.signal.aborted ? controller.signal.reason : undefined;
      const failure = aborted instanceof AllayaError ? aborted : error;
      const serialized = toSerializedError(failure);
      const cancelled = serialized.code === 'CANCELLED';
      if (!cancelled)
        this.deps.logger.warn('Tool failed', { tool: tool.name, code: serialized.code });
      return finish({
        status: cancelled ? 'cancelled' : 'failed',
        ok: false,
        risk,
        permission,
        verification: 'not_applicable',
        summary,
        error: { ...serialized, message: redactString(serialized.message) },
      });
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onUserAbort);
    }

    // 4. Verify — an action is only "done" if something independent says so.
    let verification: VerificationState;
    let evidence: string | undefined;
    if (tool.readOnly) {
      verification = 'not_applicable';
    } else if (!tool.verify) {
      verification = 'unverified';
      evidence = 'This action has no independent check, so its result could not be confirmed.';
    } else {
      try {
        const check = await raceWithAbort(
          tool.verify(args, output, { ...context, signal: options.signal }),
          AbortSignal.any([
            options.signal,
            AbortSignal.timeout(this.deps.verifyTimeoutMs ?? 10_000),
          ]),
        );
        verification = check.verified ? 'verified' : 'failed';
        evidence = check.evidence;
      } catch (error) {
        verification = 'unverified';
        evidence = `The check could not run: ${redactString(toSerializedError(error).message)}`;
      }
    }

    if (verification === 'failed') {
      return finish({
        status: 'failed',
        ok: false,
        risk,
        permission,
        output,
        verification,
        ...(evidence ? { evidence } : {}),
        summary,
        error: toSerializedError(
          new AllayaError(
            `The action ran, but the result could not be confirmed: ${evidence ?? ''}`.trim(),
            {
              code: 'VERIFICATION_FAILED',
            },
          ),
        ),
      });
    }
    return finish({
      status: 'success',
      ok: true,
      risk,
      permission,
      output,
      verification,
      ...(evidence ? { evidence } : {}),
      summary,
    });
  }
}

/** Resolves with `work`, or rejects as soon as `signal` aborts — whichever comes first. */
function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new AllayaError('Cancelled', { code: 'CANCELLED' }),
      );
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export type { ToolDefinition };
