import {
  estimateTokens,
  messageTokens,
  type AIMessage,
  type AIRequest,
  type FinishReason,
  type ToolCall,
  type Usage,
} from '@allaya/ai';
import type { AgentModel, ModelInput, ModelTurn } from '@allaya/agent';
import type { ProviderService } from '../services/provider-service';

const DEFAULT_MAX_OUTPUT = 4096;
/** Leaves room for the reply, the system prompt and the tool list. */
const CONTEXT_SAFETY_MARGIN = 2048;
const SHORTENED = '[an earlier result was shortened to save space]';
const KEEP_CHARS = 400;

/**
 * Shortens the *oldest* tool results (never the newest, never the first message) until the conversation fits.
 * A step's brief and its latest results are what the model needs; a big result from five rounds ago is not.
 */
export function shrinkOldToolResults(messages: AIMessage[], budgetTokens: number): AIMessage[] {
  const total = () => messages.reduce((n, m) => n + messageTokens(m), 0);
  if (total() <= budgetTokens) return messages;
  const copy = messages.map((message) => ({ ...message }));
  // Oldest first, but leave the most recent tool-result message alone.
  const lastResultMessage = copy
    .map((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result'))
    .lastIndexOf(true);
  for (let i = 1; i < copy.length; i += 1) {
    const message = copy[i]!;
    if (i === lastResultMessage || typeof message.content === 'string') continue;
    message.content = message.content.map((part) =>
      part.type === 'tool_result' && part.content.length > KEEP_CHARS
        ? { ...part, content: `${part.content.slice(0, KEEP_CHARS)}… ${SHORTENED}` }
        : part,
    );
    if (copy.reduce((n, m) => n + messageTokens(m), 0) <= budgetTokens) break;
  }
  return copy;
}

/**
 * The orchestrator's model, backed by the user's providers. Each call is routed on its own: planning goes to the
 * strongest model available, steps to one that fits the task's size, and every call needs a model that can use
 * tools. A model that runs out of room mid-answer is reported as cut off, never as having asked for tools.
 */
export class ProviderModel implements AgentModel {
  constructor(private readonly providers: ProviderService) {}

  async turn(input: ModelInput, signal: AbortSignal): Promise<ModelTurn> {
    const estimated =
      estimateTokens(input.system) +
      input.messages.reduce((n, m) => n + messageTokens(m), 0) +
      (input.tools ? estimateTokens(JSON.stringify(input.tools)) : 0);
    const decision = this.providers.router.select({
      purpose: input.purpose === 'plan' ? 'agent_planning' : 'general',
      ...(input.complexity ? { complexity: input.complexity } : {}),
      needsTools: (input.tools?.length ?? 0) > 0,
      estimatedInputTokens: Math.min(estimated, 6000),
    });
    const model = decision.model;
    const maxOutput = Math.min(
      input.maxTokens ?? DEFAULT_MAX_OUTPUT,
      model.capabilities.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    );
    const budget = Math.max(
      1000,
      model.capabilities.contextWindow -
        maxOutput -
        estimateTokens(input.system) -
        (input.tools ? estimateTokens(JSON.stringify(input.tools)) : 0) -
        CONTEXT_SAFETY_MARGIN,
    );
    const request: AIRequest = {
      model: model.modelId,
      system: input.system,
      messages: shrinkOldToolResults(input.messages, budget),
      maxTokens: maxOutput,
      ...(input.tools && input.tools.length > 0
        ? {
            tools: input.tools,
            toolChoice: input.forceTool ? { name: input.forceTool } : ('auto' as const),
          }
        : {}),
    };

    let text = '';
    const calls: ToolCall[] = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: FinishReason = 'stop';
    for await (const event of this.providers.provider(model.providerId).stream(request, signal)) {
      if (event.type === 'text_delta') text += event.text;
      else if (event.type === 'tool_call') calls.push(event.call);
      else if (event.type === 'usage') {
        usage = {
          inputTokens: event.usage.inputTokens ?? usage.inputTokens,
          outputTokens: event.usage.outputTokens ?? usage.outputTokens,
        };
      } else if (event.type === 'finish') finishReason = event.reason;
    }
    return {
      text,
      // A reply cut off by the length limit never runs half a request.
      calls: finishReason === 'length' ? [] : calls,
      usage,
      finishReason,
      modelLabel: model.displayName,
    };
  }
}
