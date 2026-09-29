import { estimateTokens } from './tokens';
import type { AIMessage, ContentPart } from './types';

function partTokens(part: ContentPart): number {
  switch (part.type) {
    case 'text':
      return estimateTokens(part.text);
    case 'tool_result':
      return estimateTokens(part.content) + 8;
    case 'tool_call':
      return estimateTokens(JSON.stringify(part.arguments)) + estimateTokens(part.name) + 8;
    case 'image':
      return 1500; // flat allowance; providers bill images by size
  }
}

export function messageTokens(message: AIMessage): number {
  const content =
    typeof message.content === 'string'
      ? estimateTokens(message.content)
      : message.content.reduce((n, p) => n + partTokens(p), 0);
  return content + 4; // per-message framing overhead
}

export interface FitResult {
  messages: AIMessage[];
  /** How many of the oldest messages were dropped to fit. */
  dropped: number;
  tokens: number;
}

/**
 * Keeps the most recent messages that fit `budget` tokens. Rules:
 *  - the newest message is always kept (even if it alone exceeds the budget — the router's context check decides)
 *  - the window never starts on an assistant turn or on an orphaned tool result: providers reject those
 *  - whole turns are dropped, never half of one
 */
export function fitMessagesToBudget(messages: AIMessage[], budget: number): FitResult {
  const costs = messages.map(messageTokens);
  let total = costs.reduce((a, b) => a + b, 0);
  let start = 0;
  while (start < messages.length - 1 && total > budget) {
    total -= costs[start]!;
    start += 1;
  }
  // Advance to a valid conversation start: a user turn that doesn't begin with a tool result.
  const startsBadly = (m: AIMessage) =>
    m.role !== 'user' ||
    (typeof m.content !== 'string' && m.content.some((p) => p.type === 'tool_result'));
  while (start < messages.length - 1 && startsBadly(messages[start]!)) {
    total -= costs[start]!;
    start += 1;
  }
  return { messages: messages.slice(start), dropped: start, tokens: total };
}
