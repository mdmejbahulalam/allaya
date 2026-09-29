import { RESERVED_TOOL_NAMES, type ToolFacts, type ToolPort } from '@allaya/agent';
import { CHAT_ONLY_AUTOMATION_TOOLS } from '@allaya/automation';
import type { ModelToolSpec } from '@allaya/tools';
import type { PermissionMode, PermissionSubject } from '@allaya/types';
import type { PermissionService } from '../services/permission-service';
import type { ToolService } from '../services/tool-service';

/**
 * Names the model must not be offered inside a task: the tool that starts a task and the tools that create
 * automations. Nothing that runs by itself (a task, an unattended automation run) may create more things that run
 * by themselves.
 */
const CHAT_ONLY_TOOLS: ReadonlySet<string> = new Set(['start_task', ...CHAT_ONLY_AUTOMATION_TOOLS]);

/**
 * The tool pipeline, as the orchestrator sees it. There is exactly one way to act on the computer — the same
 * `ToolService.execute` chat uses — so a task can never do anything a chat message could not: same validation,
 * same risk and permission checks, same confirmations, same audit trail.
 */
export class ToolServicePort implements ToolPort {
  constructor(
    private readonly tools: ToolService,
    private readonly permissions: PermissionService,
    private readonly conversationOf: (taskId: string) => string | undefined,
  ) {}

  specs(): ModelToolSpec[] {
    return this.tools
      .modelTools()
      .filter((spec) => !RESERVED_TOOL_NAMES.has(spec.name) && !CHAT_ONLY_TOOLS.has(spec.name));
  }

  facts(name: string): ToolFacts | undefined {
    const tool = this.tools.registry.get(name);
    if (!tool) return undefined;
    return {
      name,
      category: tool.category,
      description: tool.description,
      risk: typeof tool.risk === 'function' ? 'varies' : tool.risk,
      readOnly: tool.readOnly,
      // Tools whose needs depend on the arguments are judged at each call, not in the preview.
      subjects: typeof tool.requires === 'function' ? [] : tool.requires,
    };
  }

  modeFor(subject: PermissionSubject): PermissionMode {
    return this.permissions.modeFor(subject);
  }

  execute: ToolPort['execute'] = (call, options) =>
    this.tools.execute(call, {
      signal: options.signal,
      language: options.language,
      taskId: options.taskId,
      // Not offering a tool is not enough: a compromised model can name any tool, so the refusal is enforced here too.
      deniedTools: CHAT_ONLY_TOOLS,
      ...(this.conversationOf(options.taskId)
        ? { conversationId: this.conversationOf(options.taskId)! }
        : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
}
