import type { ProviderId } from '@allaya/types';

/**
 * Provider-neutral vocabulary. Every provider adapter translates to and from these shapes, so the
 * agent, router and UI never depend on one vendor's wire format.
 */

export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image'; mediaType: string; dataBase64: string };
/** A tool invocation requested by the model. `arguments` is already-parsed JSON. */
export type ToolCallPart = {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
export type ToolResultPart = {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
};

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

/** Tool results are carried by a `user` message (as parts); providers re-map them to their own role. */
export interface AIMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

/** JSON-Schema description of a tool the model may call. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface AIRequest {
  model: string;
  system?: string;
  messages: AIMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  temperature?: number;
}

export type FinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'cancelled';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AIResponse {
  model: string;
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
}

/** Incremental output. A complete `tool_call` is emitted once its arguments have fully arrived. */
export type StreamEvent =
  | { type: 'start'; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'finish'; reason: FinishReason };

export type ModelTier = 'fast' | 'balanced' | 'frontier';

export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
  reasoning: boolean;
  /** Context window in tokens. */
  contextWindow: number;
  maxOutputTokens?: number;
}

export interface ModelCost {
  /** USD per million tokens, where the provider publishes it. */
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface ModelInfo {
  providerId: ProviderId;
  /** The provider's own identifier. */
  modelId: string;
  displayName: string;
  capabilities: ModelCapabilities;
  tier: ModelTier;
  cost?: ModelCost;
  /** Whether capabilities came from the provider or were inferred from the model name. */
  capabilitySource: 'provider' | 'inferred';
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Milliseconds for the probe request. */
  latencyMs: number;
  modelCount?: number;
  errorCode?: string;
  errorMessage?: string;
}
