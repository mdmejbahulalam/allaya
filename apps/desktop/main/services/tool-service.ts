import type { ToolAuditRepository } from '@allaya/database';
import { RESERVED_TOOL_NAMES } from '@allaya/agent';
import { AllayaError, redact, type Logger } from '@allaya/shared';
import {
  ConfirmationBroker,
  ToolExecutor,
  ToolRegistry,
  getDatetime,
  type ConfirmationChannel,
  type ConfirmationRequest,
  type ExecuteOptions,
  type ExecutionResult,
  type ModelToolSpec,
  type ToolAuditSink,
  type ToolCallRequest,
  type ToolDefinition,
} from '@allaya/tools';
import type { ConfirmationView } from '@allaya/validation';
import type { EventPublisher } from '../ipc/events';
import type { PermissionService } from './permission-service';

const MAX_STORED_JSON = 20_000;

const clip = (json: string | undefined): string | undefined =>
  json !== undefined && json.length > MAX_STORED_JSON ? `${json.slice(0, MAX_STORED_JSON)}…` : json;

const ACTIVITY_RESULT: Record<ExecutionResult['status'], string> = {
  success: 'success',
  failed: 'failure',
  denied: 'denied',
  rejected: 'denied',
  cancelled: 'cancelled',
  invalid: 'failure',
  unknown_tool: 'failure',
  unsupported: 'failure',
};

export const toConfirmationView = (request: ConfirmationRequest): ConfirmationView => ({
  id: request.id,
  callId: request.callId,
  tool: request.tool,
  risk: request.risk,
  summary: request.summary,
  subjects: [...request.subjects],
  channels: [...request.channels],
  ...(request.conversationId ? { conversationId: request.conversationId } : {}),
  createdAt: request.createdAt,
  expiresAt: request.expiresAt,
});

export interface ToolServiceDeps {
  permissions: PermissionService;
  audit: ToolAuditRepository;
  events: EventPublisher;
  logger: Logger;
  /** Additional tools (each later phase registers its own). */
  tools?: ToolDefinition[];
  confirmationTimeoutMs?: number;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

/** Owns the tool registry and the pipeline every action goes through. */
export class ToolService {
  readonly registry = new ToolRegistry();
  readonly broker: ConfirmationBroker;
  private readonly executor: ToolExecutor;

  constructor(private readonly deps: ToolServiceDeps) {
    this.registry.register(getDatetime);
    for (const tool of deps.tools ?? []) {
      // These names belong to the agent itself (planning, finishing a step, asking the user, starting a task):
      // a real tool sharing one would be answered by the orchestrator instead of running.
      if (RESERVED_TOOL_NAMES.has(tool.name) || tool.name === 'start_task') {
        throw new AllayaError(`"${tool.name}" is reserved for the agent`, {
          code: 'INVALID_INPUT',
        });
      }
      this.registry.register(tool);
    }

    this.broker = new ConfirmationBroker({
      ...(deps.confirmationTimeoutMs !== undefined
        ? { timeoutMs: deps.confirmationTimeoutMs }
        : {}),
      ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
    });
    this.broker.events.on('requested', (request) =>
      deps.events.publish('tools:confirmationRequested', toConfirmationView(request)),
    );
    this.broker.events.on('resolved', ({ id, decision }) =>
      deps.events.publish('tools:confirmationResolved', { id, decision }),
    );

    this.executor = new ToolExecutor({
      registry: this.registry,
      modeFor: (subject) => deps.permissions.modeFor(subject),
      broker: this.broker,
      audit: this.auditSink(),
      logger: deps.logger,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.platform ? { platform: deps.platform } : {}),
    });
  }

  hasTools(): boolean {
    return this.modelTools().length > 0;
  }

  modelTools(): ModelToolSpec[] {
    return this.registry.toModelTools(this.deps.platform);
  }

  execute(call: ToolCallRequest, options: ExecuteOptions): Promise<ExecutionResult> {
    return this.executor.execute(call, options);
  }

  pendingConfirmations(): ConfirmationView[] {
    return this.broker.pending().map(toConfirmationView);
  }

  pendingFor(conversationId: string): ConfirmationRequest[] {
    return this.broker.pending().filter((request) => request.conversationId === conversationId);
  }

  respond(id: string, decision: 'approved' | 'rejected', channel: ConfirmationChannel) {
    return this.broker.respond(id, decision, channel);
  }

  /** Writes every attempted action — including refused ones — to the audit trail. */
  private auditSink(): ToolAuditSink {
    const { audit, logger } = this.deps;
    return {
      begin: (entry) =>
        audit.begin({
          id: entry.callId,
          taskId: entry.taskId,
          toolName: entry.tool,
          argumentsJson: clip(JSON.stringify(entry.arguments ?? null)) ?? 'null',
          risk: entry.risk,
          summary: entry.summary,
        }),
      finish: (result, taskId) => {
        try {
          audit.finish({
            id: result.callId,
            taskId,
            toolName: result.tool,
            summary: result.auditSummary ?? result.summary,
            risk: result.risk,
            permissionDecision: result.permission,
            status: result.status,
            ok: result.ok,
            outputJson:
              result.output === undefined
                ? undefined
                : clip(JSON.stringify(redact(result.auditOutput ?? result.output))),
            verificationJson: JSON.stringify({
              state: result.verification,
              evidence: result.evidence,
            }),
            errorJson: result.error ? JSON.stringify(result.error) : undefined,
            error: result.error?.message,
            activityResult: ACTIVITY_RESULT[result.status],
            startedAt: result.startedAt,
            completedAt: result.startedAt + result.durationMs,
            detailsJson: JSON.stringify({
              verification: result.verification,
              durationMs: result.durationMs,
            }),
          });
        } catch (error) {
          // The action already happened; losing its record is serious but must not crash the agent.
          logger.error('Could not write the audit record', {
            tool: result.tool,
            callId: result.callId,
            error: String(error),
          });
        }
      },
    };
  }
}
