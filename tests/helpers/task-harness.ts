import type { ToolCall } from '@allaya/ai';
import {
  MemoryTaskStore,
  TaskOrchestrator,
  type AgentModel,
  type ModelInput,
  type ModelTurn,
  type OrchestratorDeps,
  type TaskEventRecord,
  type TaskRecord,
  type ToolFacts,
  type ToolPort,
} from '@allaya/agent';
import type { ExecutionProgress, ExecutionResult, ModelToolSpec } from '@allaya/tools';
import type { PermissionMode, PermissionSubject, RiskLevel, ToolCategory } from '@allaya/types';
import { AllayaError } from '@allaya/shared';

let counter = 0;
export const callId = () => `mc_${(counter += 1)}`;

export const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: callId(),
  name,
  arguments: args,
});

export const turn = (
  options: { text?: string; calls?: ToolCall[]; finishReason?: ModelTurn['finishReason'] } = {},
): ModelTurn => ({
  text: options.text ?? '',
  calls: options.calls ?? [],
  usage: { inputTokens: 10, outputTokens: 5 },
  finishReason: options.finishReason ?? (options.calls?.length ? 'tool_calls' : 'stop'),
  modelLabel: 'test-model',
});

export const finishStep = (outcome: 'done' | 'failed', summary: string) =>
  turn({ calls: [call('finish_step', { outcome, summary })] });

export const submitPlan = (plan: Record<string, unknown>) =>
  turn({ calls: [call('submit_plan', plan)] });

export const finishTask = (outcome: 'achieved' | 'partial' | 'not_achieved', summary: string) =>
  turn({ calls: [call('finish_task', { outcome, summary })] });

export type Scripted =
  ModelTurn | Error | ((input: ModelInput, signal: AbortSignal) => ModelTurn | Promise<ModelTurn>);

/** A model that plays back a script, and remembers everything it was asked. */
export class ScriptedModel implements AgentModel {
  readonly inputs: ModelInput[] = [];
  constructor(private readonly script: Scripted[]) {}

  /** Adds to the end of the script (for tests that steer a run in stages). */
  push(...more: Scripted[]): void {
    this.script.push(...more);
  }

  get turns(): number {
    return this.inputs.length;
  }

  async turn(input: ModelInput, signal: AbortSignal): Promise<ModelTurn> {
    // A snapshot: the orchestrator keeps adding to its own message list after the call.
    this.inputs.push({ ...input, messages: structuredClone(input.messages) });
    const next = this.script.shift();
    if (next === undefined)
      throw new Error(`the model script ran out (call ${this.inputs.length})`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(input, signal) : next;
  }

  /** The messages of the n-th call, flattened to text — for checking what the model was told. */
  textOf(n: number): string {
    const input = this.inputs[n];
    if (!input) return '';
    return [
      input.system,
      ...input.messages.map((m) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      ),
    ].join('\n');
  }
}

export interface FakeTool {
  name: string;
  category?: ToolCategory;
  readOnly?: boolean;
  risk?: RiskLevel | 'varies';
  subjects?: PermissionSubject[];
  description?: string;
  /** What the tool does. Return a result override, or throw. */
  run?: (
    args: unknown,
    context: { signal: AbortSignal; taskId: string; stepId: string | undefined },
  ) => Partial<ExecutionResult> | undefined | Promise<Partial<ExecutionResult> | undefined>;
}

export interface ExecutedCall {
  name: string;
  arguments: unknown;
  taskId: string;
  stepId: string | undefined;
}

/** Tools as the orchestrator sees them, without the real pipeline. */
export class FakeTools implements ToolPort {
  readonly executed: ExecutedCall[] = [];
  private readonly byName = new Map<string, FakeTool>();

  constructor(tools: FakeTool[]) {
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  specs(): ModelToolSpec[] {
    return [...this.byName.values()].map((tool) => ({
      name: tool.name,
      description: tool.description ?? `${tool.name} does its thing on the computer.`,
      inputSchema: { type: 'object' },
    }));
  }

  facts(name: string): ToolFacts | undefined {
    const tool = this.byName.get(name);
    if (!tool) return undefined;
    return {
      name,
      category: tool.category ?? 'files',
      description: tool.description ?? name,
      risk: tool.risk ?? (tool.readOnly ? 'LOW' : 'MEDIUM'),
      readOnly: tool.readOnly ?? false,
      subjects: tool.subjects ?? [],
    };
  }

  modeFor(_subject: PermissionSubject): PermissionMode {
    return 'ask';
  }

  async execute(
    request: { id: string; name: string; arguments: unknown },
    options: {
      signal: AbortSignal;
      taskId: string;
      stepId: string | undefined;
      onProgress?: (progress: ExecutionProgress) => void;
    },
  ): Promise<ExecutionResult> {
    const tool = this.byName.get(request.name);
    const startedAt = Date.now();
    const base = { callId: request.id, tool: request.name, startedAt, durationMs: 1 };
    this.executed.push({
      name: request.name,
      arguments: request.arguments,
      taskId: options.taskId,
      stepId: options.stepId,
    });
    if (!tool) {
      const result: ExecutionResult = {
        ...base,
        status: 'unknown_tool',
        ok: false,
        permission: 'not_required',
        verification: 'not_applicable',
        summary: '',
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `There is no tool named "${request.name}"`,
          retryable: false,
        },
      };
      options.onProgress?.({ type: 'finished', result });
      return result;
    }
    const risk = tool.risk === 'varies' || tool.risk === undefined ? 'MEDIUM' : tool.risk;
    options.onProgress?.({
      type: 'started',
      callId: request.id,
      tool: request.name,
      summary: `${request.name} ${JSON.stringify(request.arguments)}`,
      risk,
    });
    let override: Partial<ExecutionResult> | undefined;
    try {
      override = await tool.run?.(request.arguments, {
        signal: options.signal,
        taskId: options.taskId,
        stepId: options.stepId,
      });
    } catch (error) {
      const cancelled = error instanceof AllayaError && error.code === 'CANCELLED';
      const result: ExecutionResult = {
        ...base,
        status: cancelled ? 'cancelled' : 'failed',
        ok: false,
        risk,
        permission: 'allowed',
        verification: 'not_applicable',
        summary: `${request.name}`,
        error: {
          code: cancelled ? 'CANCELLED' : 'TOOL_EXECUTION_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
      options.onProgress?.({ type: 'finished', result });
      return result;
    }
    const readOnly = tool.readOnly ?? false;
    const result: ExecutionResult = {
      ...base,
      status: 'success',
      ok: true,
      risk,
      permission: 'allowed',
      verification: readOnly ? 'not_applicable' : 'verified',
      ...(readOnly ? {} : { evidence: 'checked afterwards' }),
      summary: `${request.name}(${JSON.stringify(request.arguments)})`,
      output: { done: true },
      ...override,
    };
    options.onProgress?.({ type: 'finished', result });
    return result;
  }
}

/** A tool result for a refusal or failure, as the real pipeline would produce it. */
export const refused = (
  status: ExecutionResult['status'],
  code: NonNullable<ExecutionResult['error']>['code'],
  message: string,
  details?: Record<string, unknown>,
): Partial<ExecutionResult> => ({
  status,
  ok: false,
  verification: 'not_applicable',
  error: { code, message, retryable: false, ...(details ? { details } : {}) },
  ...(status === 'rejected' ? { permission: 'denied_by_user' as const } : {}),
  ...(status === 'denied' ? { permission: 'denied' as const } : {}),
});

export interface Harness {
  store: MemoryTaskStore;
  model: ScriptedModel;
  tools: FakeTools;
  orchestrator: TaskOrchestrator;
  events: TaskEventRecord[];
  changes: string[];
  finished: TaskRecord[];
  /** Advance the fake clock. */
  advance(ms: number): void;
  create(request: string, options?: Partial<Parameters<TaskOrchestrator['create']>[0]>): TaskRecord;
  /** Create, start and wait until nothing is running. */
  run(
    request: string,
    options?: Partial<Parameters<TaskOrchestrator['create']>[0]>,
  ): Promise<TaskRecord>;
  get(id: string): TaskRecord;
  steps(id: string): ReturnType<MemoryTaskStore['steps']>;
  states(id: string): string[];
  eventTypes(id: string): string[];
}

export function makeHarness(options: {
  script: Scripted[];
  tools?: FakeTool[];
  deps?: Partial<OrchestratorDeps>;
}): Harness {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const store = new MemoryTaskStore(now);
  const model = new ScriptedModel(options.script);
  const tools = new FakeTools(
    options.tools ?? [
      { name: 'read_file', readOnly: true, risk: 'LOW', subjects: ['file_access'] },
      { name: 'write_file', risk: 'MEDIUM', subjects: ['file_access'] },
      { name: 'move_file', risk: 'MEDIUM', subjects: ['file_access'] },
      { name: 'delete_files', risk: 'HIGH', subjects: ['delete_files'] },
    ],
  );
  const events: TaskEventRecord[] = [];
  const changes: string[] = [];
  const finished: TaskRecord[] = [];
  const orchestrator = new TaskOrchestrator({
    store,
    model,
    tools,
    now,
    backoffMs: () => 0,
    onEvent: (event) => events.push(event),
    onChange: (id) => changes.push(id),
    onFinished: (task) => finished.push(task),
    ...options.deps,
  });
  const harness: Harness = {
    store,
    model,
    tools,
    orchestrator,
    events,
    changes,
    finished,
    advance: (ms) => {
      clock += ms;
    },
    create: (request, extra) =>
      orchestrator.create({
        title: request,
        request,
        language: 'en',
        source: 'chat',
        planFirst: false,
        ...extra,
      }),
    run: async (request, extra) => {
      const task = harness.create(request, extra);
      orchestrator.start(task.id);
      await orchestrator.idle();
      return harness.get(task.id);
    },
    get: (id) => {
      const task = store.get(id);
      if (!task) throw new Error('no such task');
      return task;
    },
    steps: (id) => store.steps(id),
    states: (id) =>
      store
        .events(id)
        .filter((event) => event.type === 'STATE_CHANGED')
        .map((event) => String(event.payload?.['to'])),
    eventTypes: (id) => store.events(id).map((event) => event.type),
  };
  return harness;
}

/** Lets the event loop run until `check` passes (for tests that steer a run in progress). */
export async function waitFor(check: () => boolean, message = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}
