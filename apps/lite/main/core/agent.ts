import { toDefinitions, type Tool } from './tools';
import type { AIMessage, AIProvider, ContentPart, FinishReason, ToolCall, Usage } from '@allaya/ai';
import { AllayaError, toSerializedError } from '@allaya/shared';
import type { Step } from '../../shared/ipc';

export interface ApprovalRequest {
  tool: Tool;
  args: Record<string, unknown>;
  summary: string;
  /** Aborted when the run is stopped, so a question nobody will answer is withdrawn. */
  signal: AbortSignal;
}

export interface AgentOptions {
  provider: AIProvider;
  model: string;
  system: string;
  history: AIMessage[];
  tools?: readonly Tool[];
  /** Asked before any `write` tool runs. With none, a write tool is refused. */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  maxTokens: number;
  signal: AbortSignal;
  /** A piece of the reply, as it is written. */
  onText?: (delta: string) => void;
  /** A step started or changed. */
  onStep?: (step: Step) => void;
  /** The most times the model may call tools before it must answer. */
  maxRounds?: number;
}

export interface AgentResult {
  text: string;
  steps: Step[];
  usage: Usage;
  finish: FinishReason;
}

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const STEP_OUTPUT_CHARS = 1_500;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;

/**
 * Asks the model, runs the tools it asks for, and asks again, until it answers. Everything a tool returns goes back to
 * the model as data. A tool that fails, is unknown, or is refused is reported to the model as an error result, so it
 * can say so plainly — a failing tool never ends the conversation.
 */
export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { provider, signal } = options;
  const tools = options.tools ?? [];
  const messages: AIMessage[] = [...options.history];
  const steps: Step[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let text = '';
  let finish: FinishReason = 'stop';
  const maxRounds = options.maxRounds ?? 12;

  const publish = (step: Step) => {
    const index = steps.findIndex((s) => s.id === step.id);
    if (index === -1) steps.push(step);
    else steps[index] = step;
    options.onStep?.(step);
  };

  for (let round = 0; ; round += 1) {
    const calls: ToolCall[] = [];
    let roundText = '';
    finish = 'stop';
    const stream = provider.stream(
      {
        model: options.model,
        system: options.system,
        messages,
        maxTokens: options.maxTokens,
        ...(tools.length > 0 && round < maxRounds
          ? { tools: toDefinitions(tools), toolChoice: 'auto' as const }
          : {}),
      },
      signal,
    );
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        if (roundText === '' && text !== '' && !text.endsWith('\n')) {
          text += '\n\n';
          options.onText?.('\n\n');
        }
        roundText += event.text;
        text += event.text;
        options.onText?.(event.text);
      } else if (event.type === 'tool_call') {
        calls.push(event.call);
      } else if (event.type === 'usage') {
        usage.inputTokens += event.usage.inputTokens ?? 0;
        usage.outputTokens += event.usage.outputTokens ?? 0;
      } else if (event.type === 'finish') {
        finish = event.reason;
      }
    }
    if (calls.length === 0 || finish === 'cancelled') break;
    if (round >= maxRounds) {
      finish = 'length';
      break;
    }

    const assistant: ContentPart[] = [
      ...(roundText ? [{ type: 'text' as const, text: roundText }] : []),
      ...calls.map((c) => ({
        type: 'tool_call' as const,
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      })),
    ];
    messages.push({ role: 'assistant', content: assistant });

    const results: ContentPart[] = [];
    for (const call of calls) {
      if (signal.aborted)
        throw signal.reason ?? new AllayaError('Cancelled', { code: 'CANCELLED' });
      const tool = tools.find((t) => t.name === call.name);
      const summary = tool?.summarize?.(call.arguments) ?? call.name;
      const base = { id: call.id, tool: call.name, summary };
      if (!tool) {
        publish({ ...base, status: 'error', output: 'No such tool' });
        results.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: `There is no tool named "${call.name}".`,
          isError: true,
        });
        continue;
      }
      if (tool.effect === 'write') {
        try {
          tool.check?.(call.arguments);
        } catch (error) {
          const message = toSerializedError(error).message;
          publish({ ...base, status: 'error', output: clip(message, STEP_OUTPUT_CHARS) });
          results.push({
            type: 'tool_result',
            toolCallId: call.id,
            content: `The tool failed: ${message}`,
            isError: true,
          });
          continue;
        }
        publish({ ...base, status: 'running' });
        const allowed = options.approve
          ? await options.approve({ tool, args: call.arguments, summary, signal })
          : false;
        if (!allowed) {
          publish({ ...base, status: 'denied', output: 'The user did not allow this' });
          results.push({
            type: 'tool_result',
            toolCallId: call.id,
            content:
              'The user did not allow this action. Do not try it again; tell them it was not done.',
            isError: true,
          });
          continue;
        }
      }
      publish({ ...base, status: 'running' });
      try {
        const output = await tool.run(call.arguments, { signal });
        publish({ ...base, status: 'done', output: clip(output, STEP_OUTPUT_CHARS) });
        results.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: clip(output, MAX_TOOL_OUTPUT_CHARS),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        const message = toSerializedError(error).message;
        publish({ ...base, status: 'error', output: clip(message, STEP_OUTPUT_CHARS) });
        results.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: `The tool failed: ${message}`,
          isError: true,
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { text, steps, usage, finish };
}
